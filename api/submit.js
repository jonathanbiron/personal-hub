// /api/submit.js (Vercel serverless function - CommonJS)
const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL  = process.env.SUPABASE_URL;
const SUPABASE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY;
const FORM_SECRET   = process.env.FORM_SECRET;

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

function toE164(raw) {
  const digits = String(raw || '').replace(/\D+/g, '');
  if (digits.length === 11 && digits.startsWith('1')) return '+1' + digits.slice(1);
  if (digits.length === 10) return '+1' + digits;
  return '';
}
const clean = (s) => (s || '').toString().trim();

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // Simple shared-secret guard
  if (req.headers['x-form-secret'] !== FORM_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const { first, last, email, phone, prefs, source, honeypot } = req.body || {};
    if (honeypot) return res.status(200).json({ ok: true }); // silently drop bots

    const first_name = clean(first);
    const last_name  = clean(last);
    const em         = clean(email).toLowerCase();
    const e164       = toE164(phone);

    if (!first_name || !last_name || !em || !e164) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    // 1) Find existing contact by email or phone
    let { data: contact, error: selErr } = await supabase
      .from('contacts')
      .select('*')
      .or(`email.eq.${em},phone_e164.eq.${e164}`)
      .limit(1)
      .maybeSingle();
    if (selErr && selErr.code !== 'PGRST116') throw selErr;

    // 2) Insert or update
    if (!contact) {
      const { data, error } = await supabase
        .from('contacts')
        .insert({ email: em, phone_e164: e164, first_name, last_name })
        .select('*').single();
      if (error) throw error;
      contact = data;
    } else {
      const patch = {};
      if (!contact.first_name && first_name) patch.first_name = first_name;
      if (!contact.last_name  && last_name)  patch.last_name  = last_name;
      if (!contact.email      && em)         patch.email      = em;
      if (!contact.phone_e164 && e164)       patch.phone_e164 = e164;
      if (Object.keys(patch).length) {
        const { data, error } = await supabase
          .from('contacts').update(patch).eq('id', contact.id).select('*').single();
        if (error) throw error;
        contact = data;
      }
    }

    // 3) Upsert preferences (guided)
    const desired = {
      thrive_invites:   !!prefs?.thrive_invites,
      friday_reminders: !!prefs?.friday_reminders,
      updates:          !!prefs?.updates,
      real_insights:    !!prefs?.real_insights,
      frequency: ['invites_only','monthly','weekly'].includes(prefs?.frequency) ? prefs.frequency : 'invites_only',
      channels: Array.isArray(prefs?.channels) ? prefs.channels.filter(x => ['email','sms','app'].includes(x)) : []
    };

    const { data: pref, error: prefSelErr } = await supabase
      .from('preferences').select('contact_id').eq('contact_id', contact.id).maybeSingle();
    if (prefSelErr && prefSelErr.code !== 'PGRST116') throw prefSelErr;

    if (pref) {
      const { error } = await supabase.from('preferences').update(desired).eq('contact_id', contact.id);
      if (error) throw error;
    } else {
      const { error } = await supabase.from('preferences').insert({ contact_id: contact.id, ...desired });
      if (error) throw error;
    }

    // 4) Log submission
    const ua = req.headers['user-agent'] || '';
    const ip = req.headers['x-forwarded-for']?.split(',')[0] || req.socket?.remoteAddress || null;
    await supabase.from('submissions').insert({
      contact_id: contact.id,
      source: source || 'web',
      ip, user_agent: ua,
      payload: req.body
    });

    return res.status(200).json({ ok: true, contact_id: contact.id });
  } catch (err) {
    console.error('submit error', err);
    return res.status(500).json({ error: 'Server error' });
  }
};
