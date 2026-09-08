# Auto Clair V48 — Vision IA + OCR

Le navigateur envoie la photo au backend `/api/vision-analyze`. La clé OpenAI reste côté serveur.

## Render
- Build: `npm install`
- Start: `npm start`
- Environment: `OPENAI_API_KEY` = ta clé API OpenAI
- Optionnel: `OPENAI_MODEL=gpt-5.6-luna`

Le service sert `public/index.html`.
