const express = require("express");
const cors = require("cors");
const dotenv = require("dotenv");
const { GoogleGenAI } = require("@google/genai");

dotenv.config();

const app = express();
const port = Number(process.env.PORT) || 3000;

app.use(cors());
app.use(express.json());

const apiKey = process.env.GEMINI_API_KEY;
const ai = apiKey ? new GoogleGenAI({ apiKey }) : null;

app.post("/lyrics", async (req, res) => {
    console.log('reached');
  const { songTitle, mood, language } = req.body ?? {};
  if (typeof songTitle !== "string" || !songTitle.trim()) {
    return res.status(400).json({ error: "songTitle is required" });
  }
  if (!ai) {
    return res.status(500).json({ error: "GEMINI_API_KEY is not configured" });
  }
  const prompt = `
أنت كاتب أغانٍ. ألّف كلمات أغنية جديدة وأصلية بالكامل من الصفر.
- الموضوع العام: ${songTitle.trim()}
- المزاج: ${typeof mood === "string" && mood.trim() ? mood.trim() : "مبهج"}
- اللغة: ${typeof language === "string" && language.trim() ? language.trim() : "العربية"}

لا تحاول العثور على أغنية موجودة بهذا العنوان، ولا تقتبس أو تعِد صياغة كلمات موجودة.
لا تقلّد فنانًا أو أغنية بعينها. استخدم الموضوع العام فقط وابتكر تعبيرات وصورًا جديدة.
أخرج الكلمات فقط، مقسمة إلى [Verse 1] و[Chorus] و[Verse 2] و[Bridge] و[Outro].
`;

  try {
    const response = await ai.models.generateContent({
      model: "gemini-3.8-flash",
      contents: prompt,
    });
    const lyrics = response.text?.trim();

    if (!lyrics) {
      return res.status(502).json({ error: "AI returned an empty response" });
    }

    return res.json({ lyrics });
  } catch (error) {
    console.error("Failed to generate original lyrics:", error);
    return res.status(502).json({ error: "فشل في توليد الكلمات" });
  }
});

app.listen(port, () => {
  console.log(`Lyrics server is running on port ${port}`);
});
