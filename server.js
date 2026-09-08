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
  limits: { fileSize: 12 * 1024 * 1024 }
});

const PORT = process.env.PORT || 10000;
const MODEL = process.env.OPENAI_MODEL || "gpt-5.6-sol";

app.use(express.static(path.join(__dirname, "public")));

const schema = {
  type: "object",
  additionalProperties: false,
  properties: {
    customer: { type: ["string", "null"] },
    garage: { type: ["string", "null"] },
    vehicle: { type: ["string", "null"] },
    engine: { type: ["string", "null"] },
    power: { type: ["string", "null"] },
    cylinderCapacity: { type: ["string", "null"] },
    firstRegistration: { type: ["string", "null"] },
    mileage: { type: ["string", "null"] },
    registration: { type: ["string", "null"] },
    vin: { type: ["string", "null"] },
    technicalInspection: { type: ["string", "null"] },
    quoteNumber: { type: ["string", "null"] },
    quoteDate: { type: ["string", "null"] },
    problem: { type: ["string", "null"] },
    conditions: { type: ["string", "null"] },
    lines: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          label: { type: "string" },
          amount: { type: ["string", "null"] }
        },
        required: ["label", "amount"]
      }
    },
    totals: {
      type: "object",
      additionalProperties: false,
      properties: {
        ht: { type: ["string", "null"] },
        vat: { type: ["string", "null"] },
        ttc: { type: ["string", "null"] }
      },
      required: ["ht", "vat", "ttc"]
    },
    confidence: {
      type: "object",
      additionalProperties: false,
      properties: {
        vin: { type: "number" },
        cylinderCapacity: { type: "number" },
        lines: { type: "number" }
      },
      required: ["vin", "cylinderCapacity", "lines"]
    },
    warnings: {
      type: "array",
      items: { type: "string" }
    }
  },
  required: [
    "customer",
    "garage",
    "vehicle",
    "engine",
    "power",
    "cylinderCapacity",
    "firstRegistration",
    "mileage",
    "registration",
    "vin",
    "technicalInspection",
    "quoteNumber",
    "quoteDate",
    "problem",
    "conditions",
    "lines",
    "totals",
    "confidence",
    "warnings"
  ]
};

const instructions = `
Tu es le moteur de lecture documentaire d'AUTO CLAIR.

Analyse uniquement ce qui est VISUELLEMENT PRESENT sur le devis.
N'invente jamais.

Plusieurs vues de la même photo peuvent être fournies.
Utilise les vues zoomées pour lire les petits caractères.

VIN / NUMERO DE SERIE — PRIORITE MAXIMALE
- Le VIN contient exactement 17 caractères.
- Localise "N° de série", "VIN" ou équivalent.
- Lis chaque caractère visuellement.
- Vérifie la chaîne une deuxième fois.
- Ne corrige pas un caractère pour rendre la chaîne plausible.
- Si un caractère n'est pas réellement lisible, retourne null.
- Ajoute alors "VIN à vérifier".
- Un VIN ne contient pas I, O ou Q.
- Attention aux confusions G/6, G/C, 5/S, 1/I, D/O, 0/O.

CYLINDREE
- Cherche explicitement cm3, cm³, cc ou cm 3.
- Exemple : 1461cm3 = 1461 cm³.
- Ne confonds jamais cylindrée et puissance.

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

async function imageViews(buffer, mime) {
  if (!mime.startsWith("image/")) return [];

  const meta = await sharp(buffer).metadata();
  const w = meta.width || 0;
  const h = meta.height || 0;

  if (!w || !h) return [];

  const crops = [
    {
      name: "haut",
      top: 0,
      height: Math.round(h * 0.52)
    },
    {
      name: "centre",
      top: Math.round(h * 0.20),
      height: Math.round(h * 0.58)
    },
    {
      name: "bas",
      top: Math.round(h * 0.48),
      height: h - Math.round(h * 0.48)
    }
  ];

  const out = [];

  for (const c of crops) {
    const img = await sharp(buffer)
      .extract({
        left: 0,
        top: c.top,
        width: w,
        height: Math.min(c.height, h - c.top)
      })
      .resize({
        width: Math.min(2200, w),
        withoutEnlargement: false
      })
      .jpeg({ quality: 92 })
      .toBuffer();

    out.push({
      name: c.name,
      data: `data:image/jpeg;base64,${img.toString("base64")}`
    });
  }

  return out;
}

async function runVision(client, content) {
  const response = await client.responses.create({
    model: MODEL,
    input: [
      {
        role: "user",
        content
      }
    ],
    text: {
      format: {
        type: "json_schema",
        name: "autoclair_quote",
        strict: true,
        schema
      }
    }
  });

  return JSON.parse(response.output_text);
}

function cleanData(data) {
  data.warnings = Array.isArray(data.warnings)
    ? data.warnings
    : [];

  if (data.vin) {
    data.vin = String(data.vin)
      .toUpperCase()
      .replace(/[\s-]/g, "");

    if (
      data.vin.length !== 17 ||
      !/^[A-HJ-NPR-Z0-9]{17}$/.test(data.vin)
    ) {
      data.warnings.push(
        "VIN à vérifier : lecture non fiable."
      );

      data.confidence.vin = Math.min(
        Number(data.confidence.vin || 0),
        0.35
      );
    }
  }

  if (data.cylinderCapacity) {
    const m = String(data.cylinderCapacity)
      .match(/(\d{3,5})/);

    data.cylinderCapacity = m
      ? `${m[1]} cm³`
      : null;
  }

  const seen = new Set();

  data.lines = (data.lines || []).filter((x) => {
    const key =
      `${String(x.label).trim().toLowerCase()}|` +
      `${String(x.amount ?? "").trim()}`;

    if (seen.has(key)) return false;

    seen.add(key);
    return true;
  });

  return data;
}

app.post(
  "/api/vision-analyze",
  upload.single("document"),
  async (req, res) => {
    try {
      if (!process.env.OPENAI_API_KEY) {
        return res.status(500).json({
          error: "OPENAI_API_KEY manquante dans Render."
        });
      }

      if (!req.file) {
        return res.status(400).json({
          error: "Aucun document reçu."
        });
      }

      const client = new OpenAI({
        apiKey: process.env.OPENAI_API_KEY
      });

      const mime =
        req.file.mimetype || "image/jpeg";

      const base64 =
        req.file.buffer.toString("base64");

      const content = [
        {
          type: "input_text",
          text: instructions
        }
      ];

      if (mime === "application/pdf") {
        content.push({
          type: "input_file",
          filename:
            req.file.originalname || "devis.pdf",
          file_data:
            `data:application/pdf;base64,${base64}`
        });
      } else {
        content.push({
          type: "input_image",
          detail: "high",
          image_url:
            `data:${mime};base64,${base64}`
        });

        const views = await imageViews(
          req.file.buffer,
          mime
        );

        for (const v of views) {
          content.push({
            type: "input_text",
            text:
              `Vue zoomée ${v.name} de la même page. ` +
              `Elle sert uniquement à lire les petits caractères.`
          });

          content.push({
            type: "input_image",
            detail: "high",
            image_url: v.data
          });
        }
      }

      const data = cleanData(
        await runVision(client, content)
      );

      data.model = MODEL;
      data.pipeline =
        "Vision IA multi-vues + validation métier";

      res.json(data);

    } catch (err) {
      console.error(err);

      res.status(500).json({
        error:
          err?.message ||
          "Erreur Vision IA."
      });
    }
  }
);

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    model: MODEL
  });
});

/* Express 5 : wildcard avec paramètre nommé */
app.get("/{*splat}", (_req, res) => {
  res.sendFile(
    path.join(
      __dirname,
      "public",
      "index.html"
    )
  );
});

app.listen(PORT, () => {
  console.log(
    `Auto Clair V50 listening on ${PORT} — model ${MODEL}`
  );
});
