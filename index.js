const express = require("express");
const cors = require("cors");
const dotenv = require("dotenv");

dotenv.config();

const app = express();
const port = Number(process.env.PORT) || 3000;
const providerTimeoutMs = 20000;

app.use(cors());
app.use(express.json());

async function fetchProviderJson(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), providerTimeoutMs);

  try {
    const response = await fetch(url, {
      headers: { Accept: "application/json" },
      signal: controller.signal,
    });
    return {
      ok: response.ok,
      status: response.status,
      data: response.ok ? await response.json() : null,
    };
  } finally {
    clearTimeout(timeout);
  }
}

function normalize(value) {
  return typeof value === "string" ? value.trim().toLocaleLowerCase() : "";
}

function getLyrics(result) {
  return result?.syncedLyrics?.trim() || result?.plainLyrics?.trim() || "";
}

app.post("/lyrics", async (req, res) => {
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
  if (Number.isFinite(duration) && duration > 0) {
    params.set("duration", String(Math.round(duration)));
  }

  try {
    const exact = await fetchProviderJson(
      `https://lrclib.net/api/get?${params.toString()}`,
    );
    let match = exact.ok ? exact.data : null;

    if (exact.status === 404) {
      const search = await fetchProviderJson(
        `https://lrclib.net/api/search?${params.toString()}`,
      );
      if (!search.ok) {
        return res.status(502).json({ error: "Lyrics provider request failed" });
      }

      match = Array.isArray(search.data)
        ? search.data.find(
            (item) =>
              normalize(item.trackName) === normalize(songTitle) &&
              normalize(item.artistName) === normalize(artist),
          )
        : null;
    } else if (!exact.ok) {
      return res.status(502).json({ error: "Lyrics provider request failed" });
    }

    const lyrics = getLyrics(match);
    if (!lyrics) {
      return res.status(404).json({ error: "No lyrics found for this track" });
    }

    return res.json({ lyrics });
  } catch (error) {
    if (error.name === "AbortError") {
      console.error("Lyrics provider request timed out");
      return res.status(504).json({ error: "Lyrics provider request timed out" });
    }

    console.error("Failed to fetch track lyrics:", error);
    return res.status(502).json({ error: "Failed to connect to lyrics provider" });
  }
});

app.listen(port, () => {
  console.log(`Lyrics server is running on port ${port}`);
});
