const express = require('express');
const path = require('path');
const app = express();
const PORT = process.env.PORT || 3000;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const MODEL = process.env.OPENAI_MODEL || 'gpt-5.6-luna';
app.use(express.json({limit:'15mb'}));
app.use(express.static(path.join(__dirname,'public')));
app.get('/api/health',(req,res)=>res.json({ok:true,vision:!!OPENAI_API_KEY,model:MODEL}));
const schema={type:'object',additionalProperties:false,properties:{
 customer:{type:'string'},garage:{type:'string'},vehicle:{type:'string'},engine:{type:'string'},power:{type:'string'},cylinderCapacity:{type:'string'},firstRegistration:{type:'string'},mileage:{type:'string'},registration:{type:'string'},vin:{type:'string'},technicalInspection:{type:'string'},conditions:{type:'string'},quoteNumber:{type:'string'},quoteDate:{type:'string'},symptoms:{type:'string'},
 lines:{type:'array',items:{type:'object',additionalProperties:false,properties:{label:{type:'string'},amount:{type:'string'}},required:['label','amount']}},
 totals:{type:'object',additionalProperties:false,properties:{ht:{type:'string'},vat:{type:'string'},ttc:{type:'string'}},required:['ht','vat','ttc']}
},required:['customer','garage','vehicle','engine','power','cylinderCapacity','firstRegistration','mileage','registration','vin','technicalInspection','conditions','quoteNumber','quoteDate','symptoms','lines','totals']};
app.post('/api/vision-analyze',async(req,res)=>{try{
 if(!OPENAI_API_KEY)return res.status(500).json({error:'OPENAI_API_KEY non configurée sur le serveur.'});
 const image=req.body?.image;
 if(typeof image!=='string'||!image.startsWith('data:image/'))return res.status(400).json({error:'Image manquante ou format invalide.'});
 const prompt=`Tu es le moteur de lecture visuelle d'Auto Clair, spécialisé dans les devis automobiles français photographiés. Lis directement l'image et extrais uniquement ce qui est réellement visible. Ne devine jamais. VIN: exactement 17 caractères si lisible; un VIN ne contient jamais I, O ou Q. Relis le VIN caractère par caractère sur la ligne N° de série. Immatriculation au format français. Cylindrée en cm³. Moteur, cylindrée et puissance peuvent être sur la même ligne. Pour les lignes du devis, associe chaque montant au bon libellé et supprime les doublons. Si une donnée n'est pas lisible, renvoie une chaîne vide.`;
 const body={model:MODEL,store:false,input:[{role:'user',content:[{type:'input_text',text:prompt},{type:'input_image',image_url:image,detail:'high'}]}],text:{format:{type:'json_schema',name:'auto_clair_quote',strict:true,schema}}};
 const r=await fetch('https://api.openai.com/v1/responses',{method:'POST',headers:{Authorization:`Bearer ${OPENAI_API_KEY}`,'Content-Type':'application/json'},body:JSON.stringify(body)});
 const data=await r.json(); if(!r.ok)return res.status(r.status).json({error:data?.error?.message||'Erreur OpenAI'});
 let parsed; try{parsed=JSON.parse(data.output_text)}catch{ return res.status(502).json({error:'Réponse Vision non JSON',raw:data.output_text||''}); }
 res.json({extraction:parsed,model:data.model||MODEL});
}catch(err){console.error(err);res.status(500).json({error:err.message||'Erreur serveur'});}});
app.listen(PORT,()=>console.log(`Auto Clair Vision listening on ${PORT}`));
