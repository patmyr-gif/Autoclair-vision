import express from "express";
import multer from "multer";
import OpenAI from "openai";
import sharp from "sharp";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 12 * 1024 * 1024 } });
const PORT = process.env.PORT || 10000;
const MODEL = process.env.OPENAI_MODEL || "gpt-5.6-sol";
app.use(express.static(path.join(__dirname, "public")));

const schema = {
  type: "object", additionalProperties: false,
  properties: {
    customer:{type:["string","null"]}, garage:{type:["string","null"]}, vehicle:{type:["string","null"]}, engine:{type:["string","null"]}, power:{type:["string","null"]}, cylinderCapacity:{type:["string","null"]}, firstRegistration:{type:["string","null"]}, mileage:{type:["string","null"]}, registration:{type:["string","null"]}, vin:{type:["string","null"]}, technicalInspection:{type:["string","null"]}, quoteNumber:{type:["string","null"]}, quoteDate:{type:["string","null"]}, problem:{type:["string","null"]}, conditions:{type:["string","null"]},
    lines:{type:"array",items:{type:"object",additionalProperties:false,properties:{label:{type:"string"},amount:{type:["string","null"]}},required:["label","amount"]}},
    totals:{type:"object",additionalProperties:false,properties:{ht:{type:["string","null"]},vat:{type:["string","null"]},ttc:{type:["string","null"]}},required:["ht","vat","ttc"]},
    confidence:{type:"object",additionalProperties:false,properties:{vin:{type:"number"},cylinderCapacity:{type:"number"},lines:{type:"number"}},required:["vin","cylinderCapacity","lines"]},
    warnings:{type:"array",items:{type:"string"}}
  },
  required:["customer","garage","vehicle","engine","power","cylinderCapacity","firstRegistration","mileage","registration","vin","technicalInspection","quoteNumber","quoteDate","problem","conditions","lines","totals","confidence","warnings"]
};

const boxSchema = {
  type:"object", additionalProperties:false,
  properties:{
    found:{type:"boolean"},
    x:{type:"number"}, y:{type:"number"}, width:{type:"number"}, height:{type:"number"}
  },
  required:["found","x","y","width","height"]
};

const vinSchema = {
  type:"object", additionalProperties:false,
  properties:{vin:{type:["string","null"]},confidence:{type:"number"},note:{type:"string"}},
  required:["vin","confidence","note"]
};

const instructions = `
Tu es le moteur de lecture documentaire d'AUTO CLAIR.
Analyse uniquement ce qui est VISUELLEMENT PRESENT sur le devis. N'invente jamais.
Plusieurs vues de la même photo peuvent être fournies. Utilise les vues zoomées pour lire les petits caractères.

VIN / NUMERO DE SERIE — PRIORITE MAXIMALE
- Le VIN contient exactement 17 caractères.
- Localise "N° de série", "VIN" ou équivalent.
- Lis chaque caractère visuellement, un par un.
- Vérifie la chaîne une deuxième fois.
- Ne corrige pas un caractère pour rendre la chaîne plausible.
- Si un caractère n'est pas réellement lisible, retourne null et ajoute "VIN à vérifier".
- Un VIN ne contient pas I, O ou Q.
- Attention particulière aux confusions G/6, G/C, 5/S, 1/I, D/O, 0/O.

CYLINDREE
- Ne renseigne cylinderCapacity que si une cylindrée est réellement imprimée avec cm3, cm³, cc ou cm 3.
- "1.5 dCi 4x4" est une MOTORISATION, pas une cylindrée en cm³.
- Ne déduis jamais une cylindrée à partir de la motorisation.

PROBLEME / SYMPTOMES
- Renseigne problem uniquement si le devis comporte réellement une demande client, un problème, un symptôme ou une observation explicite.
- Si rien de tel n'est écrit, retourne null.
- Ne déduis jamais un symptôme à partir des opérations ou pièces du devis.

LIGNES DU DEVIS
- Ne conserve que les vrais postes du tableau.
- Associe chaque montant à la ligne correspondante.
- Ignore HT, TVA et TTC lorsqu'ils sont des totaux.
- Ignore les nombres parasites.
- Ne duplique jamais une ligne simplement parce qu'elle apparaît dans plusieurs vues.

DATES
- Format JJ/MM/AAAA.

REGLE GENERALE
- Donnée absente ou illisible = null.
- N'utilise jamais une valeur provenant d'un autre champ.
`;

async function dataUrl(buffer, mime="image/jpeg") { return `data:${mime};base64,${buffer.toString("base64")}`; }

async function imageViews(buffer, mime) {
  if (!mime.startsWith("image/")) return [];
  const meta = await sharp(buffer).metadata(); const w=meta.width||0,h=meta.height||0; if(!w||!h)return[];
  const crops=[{name:"haut",top:0,height:Math.round(h*.52)},{name:"centre",top:Math.round(h*.20),height:Math.round(h*.58)},{name:"bas",top:Math.round(h*.48),height:h-Math.round(h*.48)}];
  const out=[];
  for(const c of crops){const img=await sharp(buffer).extract({left:0,top:c.top,width:w,height:Math.min(c.height,h-c.top)}).resize({width:Math.min(2200,w),withoutEnlargement:false}).jpeg({quality:92}).toBuffer();out.push({name:c.name,data:await dataUrl(img)});}
  return out;
}

async function runStructured(client, content, name, outSchema) {
  const response=await client.responses.create({model:MODEL,input:[{role:"user",content}],text:{format:{type:"json_schema",name,strict:true,schema:outSchema}}});
  return JSON.parse(response.output_text);
}

async function locateVin(client, imageDataUrl) {
  return runStructured(client,[
    {type:"input_text",text:`Locate the printed VIN / N° de série on this vehicle quote. Return a tight bounding box around the entire VIN text, not the label if possible. Coordinates MUST be normalized from 0 to 1 relative to the image: x,y are the top-left; width,height are box dimensions. If you cannot locate it reliably, found=false and all coordinates 0. Do not infer the VIN value.`},
    {type:"input_image",detail:"high",image_url:imageDataUrl}
  ],"autoclair_vin_locator",boxSchema);
}

async function cropVin(buffer, box) {
  const meta=await sharp(buffer).metadata(); const w=meta.width||0,h=meta.height||0;
  if(!w||!h||!box?.found)return null;
  const padX=.06, padY=.08;
  const x=Math.max(0,Math.floor((box.x-padX)*w)); const y=Math.max(0,Math.floor((box.y-padY)*h));
  const right=Math.min(w,Math.ceil((box.x+box.width+padX)*w)); const bottom=Math.min(h,Math.ceil((box.y+box.height+padY)*h));
  if(right<=x||bottom<=y)return null;
  return sharp(buffer).extract({left:x,top:y,width:right-x,height:bottom-y}).resize({width:1800,withoutEnlargement:false}).jpeg({quality:96}).toBuffer();
}

async function verifyVin(client, cropBuffer) {
  return runStructured(client,[
    {type:"input_text",text:`You are the VIN verification pass for AutoClair. This image is a tight crop of the VIN / vehicle serial number from a quote. Read ONLY the printed VIN, character by character from left to right. Do not infer from the vehicle model, registration, or any other field. A VIN has exactly 17 characters and excludes I, O and Q. Pay special attention to G vs 6, G vs C, 5 vs S, 1 vs I, D vs O, 0 vs O. If any character is genuinely unreadable, return vin=null. If readable, return the exact 17-character string.`},
    {type:"input_image",detail:"high",image_url:await dataUrl(cropBuffer)}
  ],"autoclair_vin_verification",vinSchema);
}

function cleanData(data, verifiedVin=null) {
  data.warnings=Array.isArray(data.warnings)?data.warnings:[];
  if(data.problem===undefined)data.problem=null;
  if(data.cylinderCapacity){const m=String(data.cylinderCapacity).match(/(\d{3,5})/);data.cylinderCapacity=m?`${m[1]} cm³`:null;}
  if(verifiedVin){const v=String(verifiedVin).toUpperCase().replace(/[\s-]/g,"");if(/^[A-HJ-NPR-Z0-9]{17}$/.test(v)){data.vin=v;data.confidence.vin=1;data.warnings.push("VIN confirmé par une seconde lecture ciblée.");}else{data.warnings.push("VIN à vérifier : la seconde lecture n'est pas suffisamment fiable.");}} 
  if(data.vin){data.vin=String(data.vin).toUpperCase().replace(/[\s-]/g,"");if(data.vin.length!==17||!/^[A-HJ-NPR-Z0-9]{17}$/.test(data.vin)){data.warnings.push("VIN à vérifier : lecture non fiable.");data.confidence.vin=Math.min(Number(data.confidence.vin||0),.35);}}
  const seen=new Set();data.lines=(data.lines||[]).filter(x=>{const key=`${String(x.label).trim().toLowerCase()}|${String(x.amount??"").trim()}`;if(seen.has(key))return false;seen.add(key);return true;});
  return data;
}

app.post("/api/vision-analyze",upload.single("document"),async(req,res)=>{try{
  if(!process.env.OPENAI_API_KEY)return res.status(500).json({error:"OPENAI_API_KEY manquante dans Render."});
  if(!req.file)return res.status(400).json({error:"Aucun document reçu."});
  const client=new OpenAI({apiKey:process.env.OPENAI_API_KEY}); const mime=req.file.mimetype||"image/jpeg"; const base64=req.file.buffer.toString("base64");
  const content=[{type:"input_text",text:instructions}]; let verifiedVin=null;
  if(mime.startsWith("image/")){
    const original=await dataUrl(req.file.buffer,mime);
    let box=null; try{box=await locateVin(client,original);}catch(e){console.error("VIN locator failed",e?.message);}
    if(box?.found){try{const crop=await cropVin(req.file.buffer,box);if(crop){const check=await verifyVin(client,crop);if(check?.vin)verifiedVin=check.vin;}}catch(e){console.error("VIN verification failed",e?.message);}}
    content.push({type:"input_image",detail:"high",image_url:original});
    const views=await imageViews(req.file.buffer,mime); for(const v of views){content.push({type:"input_text",text:`Vue zoomée ${v.name} de la même page. Elle sert uniquement à lire les petits caractères.`});content.push({type:"input_image",detail:"high",image_url:v.data});}
  } else if(mime==="application/pdf"){
    content.push({type:"input_file",filename:req.file.originalname||"devis.pdf",file_data:`data:application/pdf;base64,${base64}`});
  } else return res.status(400).json({error:"Format non pris en charge."});
  const data=cleanData(await runStructured(client,content,"autoclair_quote",schema),verifiedVin); data.model=MODEL;data.pipeline="Vision IA multi-vues + double lecture VIN V51";res.json(data);
}catch(err){console.error(err);res.status(500).json({error:err?.message||"Erreur Vision IA."});}});

app.get("/health",(_req,res)=>res.json({ok:true,model:MODEL,version:"V51"}));
app.get("/{*splat}",(_req,res)=>res.sendFile(path.join(__dirname,"public","index.html")));
app.listen(PORT,()=>console.log(`Auto Clair V51 listening on ${PORT} — model ${MODEL}`));
