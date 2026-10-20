const express = require("express");
const cors = require("cors");
const dotenv = require("dotenv");
const multer = require("multer");

dotenv.config();

const app = express();
const port = Number(process.env.PORT) || 3000;

app.use(cors());
app.use(express.json());

const uploadAudio = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024, files: 1 },
});

function getNetworkErrorCode(error) {
  let current = error;
  for (let depth = 0; depth < 5 && current && typeof current === "object"; depth += 1) {
    if (typeof current.code === "string") return current.code;
    current = current.cause;
  }
  return null;
}

function normalize(value) {
  return typeof value === "string"
    ? value
        .normalize("NFKD")
        .replace(/\p{M}/gu, "")
        .toLocaleLowerCase()
        .replace(/[^\p{L}\p{N}]+/gu, " ")
        .trim()
    : "";
}

function editSimilarity(left, right) {
  if (!left || !right) return 0;
  const previous = Array.from({ length: right.length + 1 }, (_, index) => index);

  for (let row = 1; row <= left.length; row += 1) {
    let diagonal = previous[0];
    previous[0] = row;
    for (let column = 1; column <= right.length; column += 1) {
      const above = previous[column];
      previous[column] = Math.min(
        previous[column] + 1,
        previous[column - 1] + 1,
        diagonal + (left[row - 1] === right[column - 1] ? 0 : 1),
      );
      diagonal = above;
    }
  }

  return 1 - previous[right.length] / Math.max(left.length, right.length);
}

function tokenSimilarity(left, right) {
  const leftTokens = new Set(left.split(" ").filter(Boolean));
  const rightTokens = new Set(right.split(" ").filter(Boolean));
  if (!leftTokens.size || !rightTokens.size) return 0;
  const overlap = [...leftTokens].filter((token) => rightTokens.has(token)).length;
  return (2 * overlap) / (leftTokens.size + rightTokens.size);
}

function textSimilarity(left, right) {
  const normalizedLeft = normalize(left);
  const normalizedRight = normalize(right);
  if (normalizedLeft === normalizedRight) return 1;
  return Math.max(
    editSimilarity(normalizedLeft, normalizedRight),
    tokenSimilarity(normalizedLeft, normalizedRight),
  );
}

function rankTrack(track, songTitle, artist, duration) {
  const titleScore = textSimilarity(track.trackName, songTitle);
  const artistScore = textSimilarity(track.artistName, artist);
  const durationScore =
    Number.isFinite(duration) && duration > 0 && Number.isFinite(track.duration)
      ? Math.max(0, 1 - Math.abs(track.duration - duration) / 30)
      : 0.5;

  return {
    titleScore,
    artistScore,
    score: titleScore * 0.65 + artistScore * 0.3 + durationScore * 0.05,
  };
}

app.post("/identify", (req, res, next) => {
  console.log("Audio identification request received");
  uploadAudio.single("file")(req, res, (error) => {
    if (error) {
      const status = error.code === "LIMIT_FILE_SIZE" ? 413 : 400;
      return res.status(status).json({
        error:
          status === 413
            ? "Audio file exceeds the 20 MB upload limit"
            : "Invalid audio upload",
      });
    }
    next();
  });
}, async (req, res) => {
  const apiToken = process.env.AUDD_API_TOKEN?.trim();
  if (!apiToken) {
    console.error("AudD token is missing from the running server environment");
    return res.status(503).json({ error: "AudD is not configured on the server" });
  }
  if (!req.file) {
    return res.status(400).json({ error: "Audio file is required" });
  }

  try {
    const form = new FormData();
    form.append("api_token", apiToken);
    form.append("return", "apple_music,spotify");
    form.append(
      "file",
      new Blob([req.file.buffer], { type: req.file.mimetype || "application/octet-stream" }),
      req.file.originalname || "audio-upload",
    );

    const response = await fetch("https://api.audd.io/", {
      method: "POST",

      body: form,
      signal: AbortSignal.timeout(30000),
    });
    if (!response.ok) {
      console.error(`AudD request failed (${response.status})`);
      return res.status(502).json({ error: "Audio recognition provider failed" });
    }

    const data = await response.json();
    if (data.status !== "success") {
      console.error("AudD rejected the recognition request");
      return res.status(502).json({ error: "Audio recognition provider failed" });
    }
    if (!data.result) {
      return res.json({ identified: false, track: null });
    }

    const result = data.result;
    if (
      typeof result.title !== "string" ||
      !result.title.trim() ||
      typeof result.artist !== "string" ||
      !result.artist.trim()
    ) {
      return res.status(502).json({ error: "Audio recognition returned incomplete metadata" });
    }

    return res.json({
      identified: true,
      track: {
        title: result.title.trim(),
        artist: result.artist.trim(),
        album: typeof result.album === "string" ? result.album : "",
        isrc:
          (typeof result.isrc === "string" && result.isrc) ||
          (typeof result.apple_music?.isrc === "string" && result.apple_music.isrc) ||
          (typeof result.spotify?.external_ids?.isrc === "string" &&
            result.spotify.external_ids.isrc) ||
          null,
      },
    });
  } catch (error) {
    if (error.name === "TimeoutError" || error.name === "AbortError") {
      console.error("AudD recognition request timed out");
      return res.status(504).json({ error: "Audio recognition timed out" });
    }
    const networkErrorCode = getNetworkErrorCode(error);
    if (
      [
        "UND_ERR_CONNECT_TIMEOUT",
        "ETIMEDOUT",
        "ECONNREFUSED",
        "ECONNRESET",
        "ENOTFOUND",
        "EAI_AGAIN",
        "EHOSTUNREACH",
        "ENETUNREACH",
      ].includes(networkErrorCode)
    ) {
      console.error(`Backend cannot reach AudD (${networkErrorCode})`);
      return res.status(503).json({
        error: "Backend cannot reach AudD. Check outbound HTTPS connectivity or firewall settings.",
      });
    }
    console.error("Audio recognition request failed:", error);
    return res.status(502).json({ error: "Could not connect to audio recognition provider" });
  }
});

app.post("/lyrics", async (req, res) => {
  console.log("here we go");
  const { songTitle, artist, duration } = req.body ?? {};
  if (typeof songTitle !== "string" || !songTitle.trim()) {
    return res.status(400).json({ error: "songTitle is required" });
  }
  if (typeof artist !== "string" || !artist.trim()) {
    return res.status(400).json({ error: "artist is required" });
  }

  const params = new URLSearchParams({
    track_name: songTitle.trim(),
    artist_name: artist.trim(),
  });

  try {
    const response = await fetch(`https://lrclib.net/api/search?${params}`, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) {
      console.error(`Lyrics metadata search failed (${response.status})`);
      return res.status(502).json({ error: "Song search provider failed" });
    }

    const results = await response.json();
    const ranked = (Array.isArray(results) ? results : [])
      .map((track) => ({ track, ...rankTrack(track, songTitle, artist, duration) }))
      .filter(({ titleScore, artistScore }) => titleScore >= 0.35 && artistScore >= 0.35)
      .sort((left, right) => right.score - left.score)
      .slice(0, 5)
      .map(({ track, score }) => ({
        title: track.trackName,
        artist: track.artistName,
        album: track.albumName || "",
        duration: Number.isFinite(track.duration) ? track.duration : null,
        matchPercent: Math.round(score * 100),
      }));

    const providerUrl = `https://www.musixmatch.com/search/${encodeURIComponent(
      `${artist.trim()} ${songTitle.trim()}`,
    )}`;

    return res.json({ tracks: ranked, providerUrl });
  } catch (error) {
    if (error.name === "TimeoutError" || error.name === "AbortError") {
      console.error("Song search provider request timed out");
      return res.status(504).json({ error: "Song search timed out" });
    }

    console.error("Failed to search song metadata:", error);
    return res.status(502).json({ error: "Failed to connect to song search provider" });
  }
});
app.listen(port, () => {
  console.log(`Song search server is running on port ${port}`);
  console.log(
    `AudD token configured: ${process.env.AUDD_API_TOKEN?.trim() ? "yes" : "no"}`,
  );
});
