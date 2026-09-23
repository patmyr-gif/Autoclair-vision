import express from "express";
import multer from "multer";
import OpenAI from "openai";
import sharp from "sharp";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 12 * 1024 * 1024, files: 8 }
});

const PORT = process.env.PORT || 10000;
const MODEL = process.env.OPENAI_MODEL || "gpt-5.6-sol";

app.use(express.static(path.join(__dirname, "public")));

const boxSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    found: { type: "boolean" },
    sourceIndex: { type: "number" },
    x: { type: "number" },
    y: { type: "number" },
    width: { type: "number" },
    height: { type: "number" }
  },
  required: ["found", "sourceIndex", "x", "y", "width", "height"]
};

const lineSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    description: { type: "string" },
    category: { type: "string", enum: ["piece", "main_oeuvre", "diagnostic", "consommable", "forfait", "autre"] },
    quantity: { type: ["number", "null"] },
    reference: { type: ["string", "null"] },
    unitPriceHT: { type: ["string", "null"] },
    discount: { type: ["string", "null"] },
    amountHT: { type: ["string", "null"] },
    vatRate: { type: ["string", "null"] },
    amountTTC: { type: ["string", "null"] }
  },
  required: ["description", "category", "quantity", "reference", "unitPriceHT", "discount", "amountHT", "vatRate", "amountTTC"]
};

const quoteSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    customer: {
      type: "object", additionalProperties: false,
      properties: {
        name: { type: ["string", "null"] },
        address: { type: ["string", "null"] },
        phone: { type: ["string", "null"] },
        email: { type: ["string", "null"] }
      },
      required: ["name", "address", "phone", "email"]
    },
    repairer: {
      type: "object", additionalProperties: false,
      properties: {
        name: { type: ["string", "null"] },
        address: { type: ["string", "null"] },
        phone: { type: ["string", "null"] },
        email: { type: ["string", "null"] },
        quoteNumber: { type: ["string", "null"] },
        quoteDate: { type: ["string", "null"] }
      },
      required: ["name", "address", "phone", "email", "quoteNumber", "quoteDate"]
    },
    vehicle: {
      type: "object", additionalProperties: false,
      properties: {
        make: { type: ["string", "null"] },
        model: { type: ["string", "null"] },
        version: { type: ["string", "null"] },
        engine: { type: ["string", "null"] },
        fuel: { type: ["string", "null"] },
        powerCh: { type: ["string", "null"] },
        powerKW: { type: ["string", "null"] },
        cylinderCapacity: { type: ["string", "null"] },
        firstRegistration: { type: ["string", "null"] },
        year: { type: ["string", "null"] },
        registration: { type: ["string", "null"] },
        vin: { type: ["string", "null"] },
        mileage: { type: ["string", "null"] }
      },
      required: ["make", "model", "version", "engine", "fuel", "powerCh", "powerKW", "cylinderCapacity", "firstRegistration", "year", "registration", "vin", "mileage"]
    },
    customerRequest: {
      type: "object", additionalProperties: false,
      properties: {
        reason: { type: ["string", "null"] },
        symptoms: { type: ["string", "null"] },
        observations: { type: ["string", "null"] }
      },
      required: ["reason", "symptoms", "observations"]
    },
    lines: { type: "array", items: lineSchema },
    totals: {
      type: "object", additionalProperties: false,
      properties: {
        partsHT: { type: ["string", "null"] },
        laborHT: { type: ["string", "null"] },
        otherHT: { type: ["string", "null"] },
        totalHT: { type: ["string", "null"] },
        vat: { type: ["string", "null"] },
        totalTTC: { type: ["string", "null"] },
        deposit: { type: ["string", "null"] },
        totalDiscount: { type: ["string", "null"] }
      },
      required: ["partsHT", "laborHT", "otherHT", "totalHT", "vat", "totalTTC", "deposit", "totalDiscount"]
    },
    otherInformation: {
      type: "object", additionalProperties: false,
      properties: {
        technicalInspection: { type: ["string", "null"] },
        conditions: { type: ["string", "null"] },
        guarantees: { type: ["string", "null"] },
        notes: { type: ["string", "null"] }
      },
      required: ["technicalInspection", "conditions", "guarantees", "notes"]
    },
    confidence: {
      type: "object", additionalProperties: false,
      properties: {
        overall: { type: "number" },
        vin: { type: "number" },
        engine: { type: "number" },
        lines: { type: "number" },
        totals: { type: "number" }
      },
      required: ["overall", "vin", "engine", "lines", "totals"]
    },
    regions: {
      type: "object", additionalProperties: false,
      properties: {
        vin: boxSchema,
        engine: boxSchema
      },
      required: ["vin", "engine"]
    },
    warnings: { type: "array", items: { type: "string" } }
  },
  required: ["customer", "repairer", "vehicle", "customerRequest", "lines", "totals", "otherInformation", "confidence", "regions", "warnings"]
};

const verifyVinSchema = {
  type: "object", additionalProperties: false,
  properties: {
    vin: { type: ["string", "null"] },
    confidence: { type: "number" },
    note: { type: "string" }
  },
  required: ["vin", "confidence", "note"]
};

const verifyEngineSchema = {
  type: "object", additionalProperties: false,
  properties: {
    engine: { type: ["string", "null"] },
    confidence: { type: "number" },
    note: { type: "string" }
  },
  required: ["engine", "confidence", "note"]
};

const locatorSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    found: { type: "boolean" },
    x: { type: "number" },
    y: { type: "number" },
    width: { type: "number" },
    height: { type: "number" }
  },
  required: ["found", "x", "y", "width", "height"]
};

const instructions = `
Tu es le moteur de lecture documentaire d'AUTO CLAIR.

MISSION
Analyse le devis comme un DOCUMENT VISUEL COMPLET. Comprends d'abord la mise en page, les blocs, les libellés, les colonnes et les relations entre les informations. Ensuite seulement remplis le JSON.

REGLES ABSOLUES
- Utilise uniquement ce qui est réellement visible.
- Ne devine jamais.
- Une donnée absente ou réellement illisible = null.
- Ne déduis jamais une donnée à partir d'une autre donnée ou de connaissances sur le véhicule.
- Ne confonds jamais référence, numéro de devis, téléphone, immatriculation et VIN.
- Conserve le contexte de chaque donnée.
- Les dates doivent être au format JJ/MM/AAAA lorsqu'elles sont certaines.
- Pour les montants, recopie les montants imprimés. Ne remplace pas un total imprimé par un calcul.

VEHICULE
- Sépare marque, modèle, version et motorisation.
- Recopie exactement la motorisation telle qu'imprimée. Exemple : "1.5 dCi 4x4".
- Ne transforme jamais une motorisation en cylindrée.
- La cylindrée ne doit être renseignée que si elle est réellement imprimée avec cm3/cm³/cc ou dans un champ explicitement identifié comme cylindrée.
- Puissance ch et kW uniquement si imprimées.

VIN
- Localise le champ VIN / N° de série / Numéro de série.
- Lis les 17 caractères un par un de gauche à droite.
- Un VIN comporte exactement 17 caractères et n'utilise pas I, O ou Q.
- Ne rends jamais un VIN plus plausible par correction automatique.
- Si un caractère est réellement illisible, retourne null.
- Fais particulièrement attention à G/C, G/6, 5/S, 1/I, D/O et 0/O.
- Retourne regions.vin avec une boîte normalisée 0..1 autour du texte du VIN et sourceIndex correspondant à l'image où il se trouve.

MOTORISATION
- Retourne regions.engine autour du texte de motorisation/version si localisable.
- Ne normalise pas "15 dcl" en "1.5 dCi" simplement parce que ce serait plausible : lis ce qui est imprimé.
- La relecture ciblée de l'application servira à résoudre les caractères ambigus.

DEMANDE CLIENT
- reason, symptoms et observations uniquement si le document les mentionne explicitement.
- S'il n'y a aucune rubrique de demande/symptômes, retourne null.
- Ne déduis jamais un symptôme à partir des réparations proposées.

LIGNES DU DEVIS
- Comprends le tableau avant d'extraire les lignes.
- Une ligne JSON = un vrai poste du tableau.
- Conserve l'ordre visuel.
- Associe les colonnes à la bonne ligne : description, catégorie, quantité, référence, prix unitaire HT, remise, montant HT, TVA, TTC.
- Ne crée jamais de ligne pour un en-tête, total, sous-total, TVA ou pied de page.
- Une même ligne visible plusieurs fois à cause d'une autre vue/page ne doit pas être dupliquée.
- Deux lignes différentes ne doivent pas être fusionnées.
- Les lignes "fournitures diverses" restent des lignes distinctes si elles apparaissent distinctement.

TOTAUX
- Privilégie toujours les totaux imprimés.
- Ne calcule pas silencieusement un total manquant.
- Les sous-totaux partsHT/laborHT/otherHT ne sont remplis que s'ils sont explicitement présents ou associés sans ambiguïté.

CONFIANCE
- Donne une confiance honnête entre 0 et 1.
- Une lecture difficile doit diminuer la confiance.
- Ne mets pas 1 parce qu'une valeur est simplement plausible.
`;

async function dataUrl(buffer, mime = "image/jpeg") {
  return `data:${mime};base64,${buffer.toString("base64")}`;
}

async function runStructured(client, content, name, schema) {
  const response = await client.responses.create({
    model: MODEL,
    input: [{ role: "user", content }],
    text: { format: { type: "json_schema", name, strict: true, schema } }
  });
  return JSON.parse(response.output_text);
}

function normalizeVin(v) {
  return String(v || "").toUpperCase().replace(/[\s-]/g, "");
}

function validVin(v) {
  const n = normalizeVin(v);
  return /^[A-HJ-NPR-Z0-9]{17}$/.test(n) ? n : null;
}

function clean(v) {
  if (v === null || v === undefined) return null;
  const s = String(v).replace(/\s+/g, " ").trim();
  return s || null;
}

function normalizeDate(v) {
  if (!v) return null;
  const s = String(v).trim();
  const m = s.match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{2,4})$/);
  if (!m) return s;
  return `${m[1].padStart(2, "0")}/${m[2].padStart(2, "0")}/${m[3].length === 2 ? "20" + m[3] : m[3]}`;
}

function cleanData(data) {
  data.warnings = Array.isArray(data.warnings) ? data.warnings : [];

  for (const group of ["customer", "repairer", "vehicle", "customerRequest", "totals", "otherInformation"]) {
    for (const key of Object.keys(data[group] || {})) data[group][key] = clean(data[group][key]);
  }

  data.repairer.quoteDate = normalizeDate(data.repairer.quoteDate);
  data.vehicle.firstRegistration = normalizeDate(data.vehicle.firstRegistration);
  data.otherInformation.technicalInspection = normalizeDate(data.otherInformation.technicalInspection);

  if (data.vehicle.registration) {
    data.vehicle.registration = String(data.vehicle.registration).toUpperCase().replace(/\s+/g, " ").trim();
  }

  data.vehicle.vin = validVin(data.vehicle.vin);

  if (data.vehicle.cylinderCapacity) {
    const m = String(data.vehicle.cylinderCapacity).match(/\b(\d{3,5})\s*(?:cm3|cm³|cc)\b/i);
    data.vehicle.cylinderCapacity = m ? `${m[1]} cm³` : null;
  }

  data.lines = Array.isArray(data.lines) ? data.lines : [];
  const seen = new Set();

  data.lines = data.lines.filter(line => {
    line.description = clean(line.description) || "";
    line.reference = clean(line.reference);
    line.unitPriceHT = clean(line.unitPriceHT);
    line.discount = clean(line.discount);
    line.amountHT = clean(line.amountHT);
    line.vatRate = clean(line.vatRate);
    line.amountTTC = clean(line.amountTTC);

    const key = [
      line.description.toLowerCase(),
      line.quantity ?? "",
      line.reference ?? "",
      line.amountHT ?? "",
      line.amountTTC ?? ""
    ].join("|");

    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  return data;
}

async function cropBox(buffer, box, padX = 0.10, padY = 0.18) {
  const meta = await sharp(buffer).metadata();
  const w = meta.width || 0, h = meta.height || 0;
  if (!w || !h || !box?.found) return null;

  const x = Math.max(0, Math.floor((box.x - padX) * w));
  const y = Math.max(0, Math.floor((box.y - padY) * h));
  const right = Math.min(w, Math.ceil((box.x + box.width + padX) * w));
  const bottom = Math.min(h, Math.ceil((box.y + box.height + padY) * h));

  if (right <= x || bottom <= y) return null;

  return sharp(buffer)
    .extract({ left: x, top: y, width: right - x, height: bottom - y })
    .resize({ width: 2200, withoutEnlargement: false })
    .jpeg({ quality: 97 })
    .toBuffer();
}

async function verifyVin(client, crop) {
  return runStructured(client, [
    { type: "input_text", text: `
Tu effectues une SECONDE LECTURE CIBLEE d'un VIN automobile.
L'image est un zoom du champ VIN / N° de série.

Lis uniquement les caractères imprimés, de gauche à droite, un par un.
- Exactement 17 caractères.
- Pas de I, O ou Q.
- Ne déduis rien du modèle, de l'immatriculation ou de la connaissance du véhicule.
- Ne corrige pas un caractère pour obtenir une chaîne plausible.
- Si un seul caractère est réellement illisible : vin=null.
- Vérifie particulièrement G/C, G/6, 5/S, 1/I, D/O et 0/O.
` },
    { type: "input_image", detail: "original", image_url: await dataUrl(crop) }
  ], "autoclair_vin_recheck", verifyVinSchema);
}

async function verifyEngine(client, crop) {
  return runStructured(client, [
    { type: "input_text", text: `
Tu effectues une SECONDE LECTURE CIBLEE de la MOTORISATION / VERSION imprimée.
Lis exactement le texte visible.
Ne normalise pas et ne remplace pas des caractères ambigus par une motorisation connue.
Ne déduis pas la cylindrée.
Si le texte est réellement illisible : engine=null.
` },
    { type: "input_image", detail: "original", image_url: await dataUrl(crop) }
  ], "autoclair_engine_recheck", verifyEngineSchema);
}

async function locateField(client, imageDataUrl, field) {
  return runStructured(client, [
    { type: "input_text", text: `
Localise précisément le champ ${field} sur ce devis.
Retourne une boîte normalisée 0..1 autour du texte de la valeur, pas autour du titre.
Si impossible : found=false et coordonnées à 0.
` },
    { type: "input_image", detail: "original", image_url: imageDataUrl }
  ], "autoclair_field_locator", locatorSchema);
}

app.post("/api/vision-analyze", upload.array("documents", 8), async (req, res) => {
  try {
    if (!process.env.OPENAI_API_KEY) {
      return res.status(500).json({ error: "OPENAI_API_KEY manquante dans Render." });
    }

    const files = req.files || [];
    if (!files.length) {
      return res.status(400).json({ error: "Aucun document reçu." });
    }

    const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

    const content = [
      { type: "input_text", text: instructions },
      { type: "input_text", text: `SOURCE PRINCIPALE : il y a ${files.length} fichier(s). Analyse-les comme les pages/vues d'un même dossier. Construis UNE seule extraction. Ne duplique pas une information simplement parce qu'elle apparaît sur plusieurs fichiers.` }
    ];

    const imageFiles = [];
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      if (file.mimetype?.startsWith("image/")) {
        imageFiles.push({ index: i, file });
        content.push({ type: "input_text", text: `Image ${i + 1}/${files.length} — analyse cette page comme faisant partie du même document.` });
        content.push({
          type: "input_image",
          detail: "original",
          image_url: await dataUrl(file.buffer, file.mimetype)
        });
      } else if (file.mimetype === "application/pdf") {
        content.push({ type: "input_text", text: `PDF ${i + 1}/${files.length} — analyse toutes ses pages comme faisant partie du même document.` });
        content.push({
          type: "input_file",
          filename: file.originalname || `devis-${i + 1}.pdf`,
          file_data: `data:application/pdf;base64,${file.buffer.toString("base64")}`
        });
      } else {
        return res.status(400).json({ error: `Format non pris en charge : ${file.originalname || "fichier"}` });
      }
    }

    let data = await runStructured(client, content, "autoclair_quote_v52", quoteSchema);

    // Relecture ciblée du VIN, après compréhension du document complet.
    if (imageFiles.length) {
      let vinBox = data?.regions?.vin;
      let vinSource = imageFiles.find(x => x.index === Number(vinBox?.sourceIndex));

      if (!vinBox?.found || !vinSource) {
        try {
          const fallback = imageFiles[0];
          const loc = await locateField(client, await dataUrl(fallback.file.buffer, fallback.file.mimetype), "VIN / N° de série");
          if (loc?.found) {
            vinBox = { ...loc, sourceIndex: fallback.index };
            vinSource = fallback;
          }
        } catch (e) {
          console.error("VIN locator fallback failed", e?.message);
        }
      }

      if (vinBox?.found && vinSource) {
        try {
          const crop = await cropBox(vinSource.file.buffer, vinBox);
          if (crop) {
            const check = await verifyVin(client, crop);
            const verified = validVin(check?.vin);

            if (verified) {
              data.vehicle.vin = verified;
              data.confidence.vin = Math.max(0, Math.min(1, Number(check.confidence || 0)));
              data.warnings.push("VIN relu dans une zone ciblée après l'analyse complète.");
            } else {
              data.vehicle.vin = null;
              data.confidence.vin = Math.min(Number(data.confidence.vin || 0), 0.35);
              data.warnings.push("VIN à vérifier : la seconde lecture ciblée n'a pas confirmé les 17 caractères.");
            }
          }
        } catch (e) {
          console.error("VIN recheck failed", e?.message);
          data.warnings.push("VIN : contrôle ciblé indisponible.");
        }
      }

      // Relecture ciblée de la motorisation seulement si la première lecture n'est pas suffisamment sûre.
      if (data?.regions?.engine?.found && Number(data?.confidence?.engine || 0) < 0.97) {
        const engineSource = imageFiles.find(x => x.index === Number(data.regions.engine.sourceIndex));
        if (engineSource) {
          try {
            const crop = await cropBox(engineSource.file.buffer, data.regions.engine, 0.12, 0.20);
            if (crop) {
              const check = await verifyEngine(client, crop);
              if (check?.engine) {
                data.vehicle.engine = clean(check.engine);
                data.confidence.engine = Math.max(0, Math.min(1, Number(check.confidence || 0)));
                data.warnings.push("Motorisation relue dans une zone ciblée après l'analyse complète.");
              }
            }
          } catch (e) {
            console.error("Engine recheck failed", e?.message);
            data.warnings.push("Motorisation : contrôle ciblé indisponible.");
          }
        }
      }
    }

    data = cleanData(data);
    data.model = MODEL;
    data.pipeline = "Vision IA document complet → JSON structuré → relectures ciblées";
    data.version = "V52";

    return res.json(data);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err?.message || "Erreur Vision IA." });
  }
});

app.get("/health", (_req, res) => res.json({
  ok: true,
  model: MODEL,
  version: "V52",
  pipeline: "full-document-first"
}));

app.get("/", (_req, res) =>
  res.sendFile(path.join(__dirname, "index.html"))
);

app.get("/{*splat}", (_req, res) =>
  res.sendFile(path.join(__dirname, "index.html"))
);

app.listen(PORT, () =>
  console.log(`Auto Clair V52 listening on ${PORT} — model ${MODEL}`)
);
