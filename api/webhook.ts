// api/webhook.ts
import type { VercelRequest, VercelResponse } from '@vercel/node';
import OpenAI from 'openai';
import { Yazio } from 'yazio/dist/index.js';

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN!;
const PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_NUMBER_ID!;
const VERIFY_TOKEN = process.env.WHATSAPP_VERIFY_TOKEN!;

// Funzione helper per inviare messaggi tramite WhatsApp Cloud API
async function sendWhatsAppMessage(to: string, text: string) {
  await fetch(`https://graph.facebook.com/v19.0/${PHONE_NUMBER_ID}/messages`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${WHATSAPP_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      to,
      type: 'text',
      text: { body: text },
    }),
  });
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  // --- 1. VERIFICA WEBHOOK (GET) ---
  // Meta chiama questo endpoint con GET per validare il webhook al setup
  if (req.method === 'GET') {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];

    if (mode === 'subscribe' && token === VERIFY_TOKEN) {
      return res.status(200).send(challenge);
    }
    return res.status(403).send('Verifica fallita');
  }

  // --- 2. RICEZIONE MESSAGGI (POST) ---
  if (req.method === 'POST') {
    try {
      const body = req.body;

      // Naviga in modo sicuro la struttura del payload di WhatsApp
      const entry = body?.entry?.[0];
      const change = entry?.changes?.[0];
      const value = change?.value;
      const message = value?.messages?.[0];

      // Se non c'è un messaggio (es. è uno status update di "letto/consegnato"), ignora
      if (!message) {
        return res.status(200).json({ status: 'ignored, no message' });
      }

      const from = message.from; // numero di telefono del mittente
      const messageType = message.type;

      // Gestione di tipi di messaggio non supportati (immagini, audio, ecc.)
      if (messageType !== 'text') {
        await sendWhatsAppMessage(
          from,
          'Mi spiace, al momento posso elaborare solo messaggi di testo. Descrivi cosa hai mangiato in parole! 🍽️'
        );
        return res.status(200).json({ status: 'unsupported type' });
      }

      const userText = message.text?.body;

      if (!userText) {
        return res.status(200).json({ status: 'empty text' });
      }

      // --- 3. ELABORAZIONE AI (OpenAI) ---
      let alimento: string;
      let quantita_grammi: number;

      try {
        const aiResponse = await openai.chat.completions.create({
          model: 'gpt-4o-mini',
          response_format: { type: 'json_object' },
          messages: [
            {
              role: 'system',
              content: `Sei un estrattore di dati nutrizionali. L'utente descrive cosa ha mangiato.
              Estrai SOLO un oggetto JSON con questa struttura esatta, senza testo aggiuntivo:
              { "alimento": "string (nome generico dell'alimento in italiano, es. 'Petto di pollo')", "quantita_grammi": number (quantità stimata in grammi, default 100 se non specificato) }`,
            },
            { role: 'user', content: userText },
          ],
        });

        const parsed = JSON.parse(aiResponse.choices[0].message.content || '{}');
        alimento = parsed.alimento;
        quantita_grammi = Number(parsed.quantita_grammi);

        if (!alimento || !quantita_grammi || isNaN(quantita_grammi)) {
          throw new Error('Dati AI non validi');
        }
      } catch (aiError) {
        console.error('Errore OpenAI:', aiError);
        await sendWhatsAppMessage(
          from,
          'Non sono riuscito a capire cosa hai mangiato. Puoi riprovare descrivendolo diversamente? (es. "150g di pollo")'
        );
        return res.status(200).json({ status: 'ai parsing failed' });
      }

      // --- 4. INTEGRAZIONE YAZIO ---
        // --- 4. INTEGRAZIONE YAZIO ---
      try {
      // Inizializza il client Yazio con username/password (credenziali)
        const yazio = new Yazio({
          username: process.env.YAZIO_USERNAME!,
          password: process.env.YAZIO_PASSWORD!,
        });

        // Cerca l'alimento nel database Yazio
        const searchResults = await yazio.products.search({ query: alimento });

        if (!searchResults || searchResults.length === 0) {
          await sendWhatsAppMessage(
            from,
            `Ho capito "${alimento}" (${quantita_grammi}g), ma non l'ho trovato su Yazio. Provo con un nome più generico?`
          );
          return res.status(200).json({ status: 'food not found' });
        }

        // Prende il primo risultato pertinente
        const product = searchResults[0];

        // Registra il pasto per la data odierna
        const today = new Date().toISOString().split('T')[0]; // formato YYYY-MM-DD

        await yazio.user.addConsumedItem({
          product_id: product.product_id,
          amount: quantita_grammi,
          serving: product.serving,
          serving_quantity: product.serving_quantity,
          date: today,
          daytime: 'snack',
        });

        // --- 5. CONFERMA ALL'UTENTE ---
        await sendWhatsAppMessage(
          from,
          `✅ Ho registrato ${quantita_grammi}g di ${product.name || alimento} su Yazio!`
        );

        return res.status(200).json({ status: 'success' });
      } catch (yazioError) {
        console.error('Errore Yazio:', yazioError);
        await sendWhatsAppMessage(
          from,
          `Ho capito "${alimento}" (${quantita_grammi}g), ma c'è stato un problema nel registrarlo su Yazio. Riprova più tardi.`
        );
        return res.status(200).json({ status: 'yazio error' });
      }
    } catch (generalError) {
      console.error('Errore generale webhook:', generalError);
      // Rispondi sempre 200 a Meta per evitare retry infiniti su payload malformati
      return res.status(200).json({ status: 'error', message: 'internal error' });
    }
  }

  return res.status(405).send('Metodo non consentito');
}