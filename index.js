const express =require("express")
const cors= require('cors');
const dotenv =require('dotenv');
const {GoogleGenAI} =require('@google/genai');

dotenv.config();
const app=express();
app.use(cors());
app.use(express.json());
const ai =new GoogleGenAI({apiKey:process.env.GEMINI_API_KEY});
app.post('/generated_lyrics',async(res,req)=>{
    try{
        const {songTitle,artist,mood,language}=req.body;
        const prompt =
        `
      أنت كاتب أغاني ومؤلف موسيقي محترف.
      اكتب كلمات أغنية جديدة ومبتكرة متناسقة مع التفاصيل التالية:
      - عنوان/موضوع الأغنية: ${songTitle || 'غير محدد'}
      - أسلوب الفنان/النمط: ${artist || 'عام'}
      - الشعور/المزاج: ${mood || 'عاطفي'}
      - اللغة/اللهجة: ${language || 'العربية'}

      يرجى تقسيم الكلمات بالتنسيق التالي:
      [Verse 1]
      [Chorus]
      [Verse 2]
      [Bridge]
      [Outro]
    `;
        const response=await ai.models.generateContent({
            model: 'gemini-2.5-flash',
            contents:prompt
        })
        response.json({lyrics:response.text});
    }catch(err){
        res.status(500).json({ error: "فشل في توليد الكلمات" });
        throw new Error(err,'Failed to generate Lyrics');
    }

})
const PORT =process.env.PORT || 4000;
app.listen(process.env.PORT,async()=>{
console.log('the Server Is running');
})