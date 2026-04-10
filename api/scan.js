export const config = { maxDuration: 60 };

const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const NOTION_KEY = process.env.NOTION_API_KEY;
const CONTACTS_DB = process.env.NOTION_CONTACTS_DB_ID;
const CLIENTS_DB = process.env.NOTION_CLIENTS_DB_ID;

function notion(path, method = "GET", body) {
  return fetch(`https://api.notion.com/v1${path}`, {
    method,
    headers: {
      "Authorization": `Bearer ${NOTION_KEY}`,
      "Notion-Version": "2022-06-28",
      "Content-Type": "application/json"
    },
    body: body ? JSON.stringify(body) : undefined
  }).then(r => r.json());
}

function similarity(a, b) {
  const clean = s => s.toLowerCase().replace(/[^a-z0-9]/g, "");
  const ca = clean(a), cb = clean(b);
  if (!ca || !cb) return 0;
  if (ca === cb) return 100;
  if (ca.includes(cb) || cb.includes(ca)) return 80;
  const bigrams = s => new Set(Array.from({ length: Math.max(0, s.length - 1) }, (_, i) => s.slice(i, i + 2)));
  const A = bigrams(ca), B = bigrams(cb);
  const inter = [...A].filter(x => B.has(x)).length;
  return Math.round((2 * inter / ((A.size + B.size) || 1)) * 100);
}

function parseVCards(text) {
  const cards = [];
  const blocks = text.split(/BEGIN:VCARD/i).slice(1);
  for (const block of blocks) {
    const unfolded = block.replace(/\r\n[ \t]/g, "").replace(/\r\n|\r|\n/g, "\n");
    const get = key => {
      const m = unfolded.match(new RegExp(`^${key}[^:\n]*:(.*)`, "im"));
      return m ? m[1].trim() : "";
    };
    const n = get("N").split(";");
    const nom = (n[0] || "").trim();
    const prenom = (n[1] || "").trim();
    const fn = get("FN").trim();
    const nomFinal = nom || fn.split(" ").slice(-1)[0] || "";
    const prenomFinal = prenom || (fn.includes(" ") ? fn.split(" ").slice(0, -1).join(" ") : "");
    const org = get("ORG").replace(/;/g, " ").trim();
    const titre = get("TITLE").trim() || get("ROLE").trim();
    const telM = unfolded.match(/^TEL[^:\n]*:(.+)/im);
    const emailM = unfolded.match(/^EMAIL[^:\n]*:(.+)/im);
    const urlM = unfolded.match(/^URL[^:\n]*:(.+)/im);
    const adrM = unfolded.match(/^ADR[^:\n]*:(.+)/im);
    const note = get("NOTE").replace(/\\n/g, " ").trim();
    const adresse = adrM ? adrM[1].split(";").filter(Boolean).join(", ").trim() : "";
    if (nomFinal || prenomFinal || org || emailM) {
      cards.push({ nom: nomFinal, prenom: prenomFinal, entreprise: org, poste: titre, email: emailM ? emailM[1].trim() : "", telephone: telM ? telM[1].trim() : "", site_web: urlM ? urlM[1].trim() : "", adresse, notes: note });
    }
  }
  return cards;
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const { action } = req.body;

  if (action === "analyze") {
    const { imageBase64, mediaType } = req.body;
    if (!imageBase64) return res.status(400).json({ error: "Image manquante" });
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": ANTHROPIC_KEY, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model: "claude-opus-4-5", max_tokens: 800, system: `Tu es un expert OCR. Analyse la carte de visite. Réponds UNIQUEMENT en JSON valide sans markdown. Format: {"nom":"","prenom":"","entreprise":"","poste":"","email":"","telephone":"","site_web":"","linkedin":"","adresse":""}. Valeur "" si absent. Ne jamais inventer.`, messages: [{ role: "user", content: [{ type: "image", source: { type: "base64", media_type: mediaType || "image/jpeg", data: imageBase64 } }, { type: "text", text: "Extrais toutes les informations de cette carte de visite." }] }] })
    });
    const d = await r.json();
    const raw = (d.content || []).map(b => b.text || "").join("").replace(/```json|```/g, "").trim();
    try { return res.status(200).json({ success: true, data: JSON.parse(raw) }); }
    catch { return res.status(500).json({ error: "Impossible d'analyser", raw }); }
  }

  if (action === "check_duplicates") {
    const { entreprise } = req.body;
    if (!entreprise || entreprise.length < 2) return res.status(200).json({ matches: [] });
    const data = await notion(`/databases/${CLIENTS_DB}/query`, "POST", { page_size: 100 });
    const matches = (data.results || []).map(p => ({ id: p.id, nom: p.properties?.Nom?.title?.[0]?.plain_text || "", score: 0 })).map(m => ({ ...m, score: similarity(entreprise, m.nom) })).filter(m => m.score >= 50).sort((a, b) => b.score - a.score).slice(0, 3);
    return res.status(200).json({ matches });
  }

  if (action === "create_contact") {
    const { contact } = req.body;
    if (!contact) return res.status(400).json({ error: "Contact manquant" });
    const nomComplet = [contact.prenom, contact.nom].filter(Boolean).join(" ") || "Contact sans nom";
    const props = { "Nom complet": { title: [{ text: { content: nomComplet } }] }, "Statut contact": { select: { name: "Lead chaud" } } };
    if (contact.poste) props["Rôle / Poste"] = { rich_text: [{ text: { content: contact.poste } }] };
    if (contact.email) props["Email"] = { email: contact.email };
    if (contact.telephone) props["Téléphone"] = { phone_number: contact.telephone };
    if (contact.linkedin) props["LinkedIn"] = { url: contact.linkedin.startsWith("http") ? contact.linkedin : `https://${contact.linkedin}` };
    if (contact.notes) props["Notes"] = { rich_text: [{ text: { content: contact.notes } }] };
    if (contact.entreprise_notion_id) props["Entreprise"] = { relation: [{ id: contact.entreprise_notion_id }] };
    const page = await notion("/pages", "POST", { parent: { database_id: CONTACTS_DB }, icon: { emoji: "👤" }, properties: props });
    if (page.object === "error") return res.status(500).json({ error: page.message });
    return res.status(200).json({ success: true, page_url: page.url, id: page.id });
  }

  if (action === "import_vcards") {
    const { vcfContent } = req.body;
    if (!vcfContent) return res.status(400).json({ error: "Contenu vCard manquant" });
    const contacts = parseVCards(vcfContent);
    if (!contacts.length) return res.status(400).json({ error: "Aucun contact valide trouvé" });
    const [clientsData, contactsData] = await Promise.all([
      notion(`/databases/${CLIENTS_DB}/query`, "POST", { page_size: 100 }),
      notion(`/databases/${CONTACTS_DB}/query`, "POST", { page_size: 100 })
    ]);
    const existingClients = (clientsData.results || []).map(p => ({ id: p.id, nom: p.properties?.Nom?.title?.[0]?.plain_text || "" }));
    const existingEmails = new Set((contactsData.results || []).map(p => p.properties?.Email?.email || "").filter(Boolean).map(e => e.toLowerCase()));
    const results = { created: [], skipped: [], errors: [] };
    for (const contact of contacts) {
      try {
        if (contact.email && existingEmails.has(contact.email.toLowerCase())) { results.skipped.push({ nom: [contact.prenom, contact.nom].filter(Boolean).join(" "), reason: "Email déjà existant" }); continue; }
        const nomComplet = [contact.prenom, contact.nom].filter(Boolean).join(" ") || contact.entreprise || "Contact";
        const props = { "Nom complet": { title: [{ text: { content: nomComplet } }] }, "Statut contact": { select: { name: "Lead froid" } } };
        if (contact.poste) props["Rôle / Poste"] = { rich_text: [{ text: { content: contact.poste } }] };
        if (contact.email) props["Email"] = { email: contact.email };
        if (contact.telephone) props["Téléphone"] = { phone_number: contact.telephone };
        if (contact.site_web) props["LinkedIn"] = { url: contact.site_web };
        const notesParts = [contact.adresse, contact.notes].filter(Boolean);
        if (notesParts.length) props["Notes"] = { rich_text: [{ text: { content: notesParts.join(" — ") } }] };
        if (contact.entreprise) {
          const match = existingClients.map(c => ({ ...c, score: similarity(contact.entreprise, c.nom) })).filter(c => c.score >= 70).sort((a, b) => b.score - a.score)[0];
          if (match) props["Entreprise"] = { relation: [{ id: match.id }] };
        }
        const page = await notion("/pages", "POST", { parent: { database_id: CONTACTS_DB }, icon: { emoji: "👤" }, properties: props });
        if (page.object === "error") { results.errors.push({ nom: nomComplet, reason: page.message }); }
        else { results.created.push({ nom: nomComplet, url: page.url }); if (contact.email) existingEmails.add(contact.email.toLowerCase()); }
        await new Promise(r => setTimeout(r, 120));
      } catch (err) { results.errors.push({ nom: [contact.prenom, contact.nom].filter(Boolean).join(" "), reason: err.message }); }
    }
    return res.status(200).json({ success: true, total: contacts.length, ...results });
  }

  if (action === "ios_shortcut") {
    const { contact, secret } = req.body;
    const IOS_SECRET = process.env.IOS_SHORTCUT_SECRET || "";
    if (IOS_SECRET && secret !== IOS_SECRET) return res.status(401).json({ error: "Non autorisé" });
    if (!contact) return res.status(400).json({ error: "Contact manquant" });
    const nomComplet = [contact.prenom, contact.nom].filter(Boolean).join(" ") || "Contact iPhone";
    const props = { "Nom complet": { title: [{ text: { content: nomComplet } }] }, "Statut contact": { select: { name: "Lead froid" } } };
    if (contact.poste) props["Rôle / Poste"] = { rich_text: [{ text: { content: contact.poste } }] };
    if (contact.email) props["Email"] = { email: contact.email };
    if (contact.telephone) props["Téléphone"] = { phone_number: contact.telephone };
    const notesParts = [contact.entreprise && `Société : ${contact.entreprise}`, contact.adresse].filter(Boolean);
    if (notesParts.length) props["Notes"] = { rich_text: [{ text: { content: notesParts.join("\n") } }] };
    const page = await notion("/pages", "POST", { parent: { database_id: CONTACTS_DB }, icon: { emoji: "📱" }, properties: props });
    if (page.object === "error") return res.status(500).json({ error: page.message });
    return res.status(200).json({ success: true, message: `✅ ${nomComplet} ajouté dans Notion !`, page_url: page.url });
  }

  return res.status(400).json({ error: "Action inconnue" });
}
