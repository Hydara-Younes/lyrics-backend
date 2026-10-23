const express = require("express");
const cors = require("cors");
const dotenv = require("dotenv");
const { Groq } = require("groq-sdk");
dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

function normalizeText(value) {
  return String(value ?? "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

function textSimilarity(left, right) {
  const leftText = normalizeText(left);
  const rightText = normalizeText(right);
  if (!leftText || !rightText) return 0;
  if (leftText === rightText) return 1;

  const leftWords = new Set(leftText.split(/\s+/));
  const rightWords = new Set(rightText.split(/\s+/));
  const overlap = [...leftWords].filter((word) => rightWords.has(word)).length;

  return (2 * overlap) / (leftWords.size + rightWords.size);
}

function rankTrack(track, title, artist, duration) {
  const titleScore = textSimilarity(track.trackName, title);
  const artistScore = textSimilarity(track.artistName, artist);
  const durationScore =
    duration && Number.isFinite(track.duration) && track.duration > 0
      ? Math.max(
          0,
          1 - Math.abs(track.duration - duration) / Math.max(track.duration, duration)
        )
      : 0;

  return {
    titleScore,
    artistScore,
    score:
      titleScore * 0.55 +
      artistScore * 0.4 +
      (duration ? durationScore * 0.05 : 0),
  };
}

function hasLyrics(track) {
  return Boolean(
    (typeof track.syncedLyrics === "string" && track.syncedLyrics.trim()) ||
    (typeof track.plainLyrics === "string" && track.plainLyrics.trim())
  );
}

function toMetadata(track, score) {
  return {
    title: track.trackName,
    artist: track.artistName,
    album: track.albumName || "",
    duration: Number.isFinite(track.duration) ? track.duration : null,
    matchPercent: Math.round(score * 100),
  };
}

/**
 * Queries the LRCLIB search endpoint.
 * Throws on network/timeout problems and on unexpected HTTP errors.
 */
async function searchLrclib(params) {
  const response = await fetch(`https://lrclib.net/api/search?${params.toString()}`, {
    headers: {
      Accept: "application/json",
      "User-Agent": "OfflineMusicPlayer/1.0",
    },
    signal: AbortSignal.timeout(15000),
  });

  if (!response.ok) {
    const error = new Error(`LRCLIB returned HTTP ${response.status}`);
    error.status = response.status;
    throw error;
  }

  const results = await response.json();

  if (!Array.isArray(results)) {
    throw new Error("LRCLIB returned an invalid response");
  }

  return results;
}

async function fetchLyricsOvh(artist, title) {
  const url =
    `https://api.lyrics.ovh/v1/` +
    `${encodeURIComponent(artist)}/` +
    `${encodeURIComponent(title)}`;

  const response = await fetch(url, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(10000),
  });

  if (response.status === 404) {
    return { status: "not_found", lyrics: null };
  }

  if (!response.ok) {
    throw new Error(`Lyrics.ovh returned HTTP ${response.status}`);
  }

  const data = await response.json();

  if (typeof data.lyrics !== "string" || !data.lyrics.trim()) {
    return { status: "not_found", lyrics: null };
  }

  return {
    status: "found",
    lyrics: data.lyrics.trim(),
  };
}

app.post("/lyrics", async (req, res) => {
  console.log("reached");
  const { songTitle, artist, duration } = req.body ?? {};

  if (typeof songTitle !== "string" || !songTitle.trim()) {
    return res.status(400).json({ error: "songTitle is required" });
  }

  const title = songTitle.trim();
  const artistName = typeof artist === "string" ? artist.trim() : "";

  const numericDuration = Number(duration);
  const trackDuration =
    duration !== undefined &&
    duration !== null &&
    duration !== "" &&
    Number.isFinite(numericDuration) &&
    numericDuration > 0
      ? numericDuration
      : undefined;

  const providerUrl =
    `https://www.musixmatch.com/search/` +
    encodeURIComponent(`${artistName} ${title}`.trim());

  let lrclibAvailable = false;
  let lrclibMatch = null;
  let tracks = [];

  // --------------------------------------------------
  // 1. Search LRCLIB with the exact track + artist.
  // --------------------------------------------------
  try {
    const params = new URLSearchParams();
    params.set("track_name", title);
    if (artistName) params.set("artist_name", artistName);

    const results = await searchLrclib(params);
    lrclibAvailable = true;

    const ranked = results
      .map((track) => ({
        track,
        ...rankTrack(track, title, artistName, trackDuration),
      }))
      .filter(
        ({ titleScore, artistScore }) =>
          titleScore >= 0.35 && artistScore >= 0.35
      )
      .sort((a, b) => b.score - a.score);

    lrclibMatch = ranked.find(({ track }) => hasLyrics(track)) ?? null;

    tracks = ranked.slice(0, 5).map(({ track, score }) => toMetadata(track, score));
  } catch (error) {
    console.error("LRCLIB search failed:", error.message);
    if (error.status === 400) lrclibAvailable = true;
  }

  // --------------------------------------------------
  // 1b. Title-only fallback.
  // --------------------------------------------------
  if (!lrclibMatch) {
    try {
      const fuzzyParams = new URLSearchParams({ track_name: title });

      const results = await searchLrclib(fuzzyParams);
      lrclibAvailable = true;

      const scored = results
        .map((track) => ({
          track,
          ...rankTrack(track, title, artistName, trackDuration),
        }))
        .filter(({ titleScore }) => titleScore >= 0.45)
        .sort((a, b) => b.score - a.score);

      lrclibMatch =
        scored.find(
          ({ track }) =>
            normalizeText(track.trackName) === normalizeText(title) &&
            hasLyrics(track)
        ) ?? scored.find(({ track }) => hasLyrics(track)) ?? null;

      if (tracks.length === 0) {
        tracks = scored.slice(0, 5).map(({ track, score }) => toMetadata(track, score));
      }
    } catch (error) {
      console.error("LRCLIB title-only search failed:", error.message);
      if (error.status === 400) lrclibAvailable = true;
    }
  }

  if (lrclibMatch) {
    const track = lrclibMatch.track;

    return res.json({
      tracks,
      lyrics: typeof track.plainLyrics === "string" ? track.plainLyrics : null,
      syncedLyrics:
        typeof track.syncedLyrics === "string" ? track.syncedLyrics : null,
      source: "lrclib",
      providerUrl,
    });
  }

  // --------------------------------------------------
  // 2. Fall back to Lyrics.ovh.
  // --------------------------------------------------
  try {
    const fallback = artistName
      ? await fetchLyricsOvh(artistName, title)
      : { status: "not_found", lyrics: null };

    if (fallback.status === "found") {
      return res.json({
        tracks,
        lyrics: fallback.lyrics,
        syncedLyrics: null,
        source: "lyrics.ovh",
        providerUrl,
      });
    }

    if (lrclibAvailable) {
      return res.json({
        tracks,
        lyrics: null,
        syncedLyrics: null,
        source: null,
        providerUrl,
      });
    }

    return res.status(502).json({
      error: "Lyrics providers are unavailable",
      tracks: [],
      lyrics: null,
      syncedLyrics: null,
      providerUrl,
    });
  } catch (error) {
    console.error("Lyrics.ovh fallback failed:", error.message);

    if (lrclibAvailable) {
      return res.json({
        tracks,
        lyrics: null,
        syncedLyrics: null,
        source: null,
        providerUrl,
      });
    }

    return res.status(502).json({
      error: "Could not connect to lyrics providers",
      tracks: [],
      lyrics: null,
      syncedLyrics: null,
      providerUrl,
    });
  }
});

// --------------------------------------------------
// 3. Groq — generate/fetch lyrics via chat completion.
// --------------------------------------------------
app.post("/api/groq-lyrics", async (req, res) => {
  console.log("reached");
  const { songTitle, artist } = req.body ?? {};

  if (typeof songTitle !== "string" || !songTitle.trim()) {
    return res.status(400).json({ error: "songTitle is required" });
  }

  if (!process.env.GROQ_API_KEY) {
    return res.status(500).json({
      error: "Groq API key is not configured on the server",
      lyrics: null,
      syncedLyrics: null,
      source: null,
    });
  }

  // If the client disconnects (frontend AbortController fires), stop
  // processing so the Express request does not hang indefinitely.
  const abortController = new AbortController();
  req.on("close", () => {
    if (req.aborted || res.writableEnded) {
      abortController.abort();
    }
  });

  try {
    const completion = await groq.chat.completions.create(
      {
        messages: [
          {
            role: "system",
            content:
              "You are a precise lyrics assistant. Return ONLY the song lyrics text. " +
              "Do not add introductions, explanations, disclaimers, or markdown code blocks. " +
              "If synchronized lyrics (timestamps) are known, return them in LRC format " +
              "with [mm:ss] or [mm:ss.xx] tags. Otherwise return plain verse/chorus text.",
          },
          {
            role: "user",
            content: `Provide the lyrics for "${songTitle.trim()}"${
              artist && artist.trim()
                ? ` by "${artist.trim()}"`
                : ""
            }.`,
          },
        ],
        model: "llama-3.1-8b-instant",
        temperature: 0.2,
        max_tokens: 2500,
      },
      { signal: abortController.signal }
    );

    const raw = completion.choices[0]?.message?.content;
    const lyrics = raw ? raw.trim() : null;

    if (!lyrics) {
      return res.status(404).json({
        error: "Groq returned no lyrics",
        lyrics: null,
        syncedLyrics: null,
        source: null,
      });
    }

    const isSynced = /\[\d{1,2}:\d{2}(?:[.:]\d{1,3})?\]/.test(lyrics);

    return res.json({
      lyrics,
      syncedLyrics: isSynced ? lyrics : null,
      source: "groq",
      providerUrl: null,
      tracks: [],
    });
  } catch (error) {
    console.error("Groq lyrics error:", error.message);
    return res.status(500).json({
      error: "Groq lyrics generation failed: " + error.message,
      lyrics: null,
      syncedLyrics: null,
      source: null,
    });
  }
});

app.listen(PORT, () => {
  console.log("Server Started on Port", PORT);
});
