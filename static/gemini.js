// Browser client: sends requests to your Cloudflare Worker, which holds the Gemini key.
(function () {
  const MAX_CHARS = 3000;

  const CRISIS = {
    crisis: true,
    message: "I'm sorry you're going through something so difficult. You deserve support from a real person. Contact someone you trust. If you may hurt yourself or someone else, or are in immediate danger, seek emergency help now.",
    helplines: [
      { name: "Tele-MANAS (India mental health helpline)", contact: "14416" },
      { name: "Emergency services (India)", contact: "112" }
    ]
  };
  const CRISIS_RE = /\b(kill myself|killing myself|suicid\w*|end my life|want to die|wanna die|self[- ]?harm|hurt myself|no reason to live|better off dead|kill someone|hurt someone)\b/i;

  const CFG = window.FLOWSPACE_CONFIG || {};
  const getUrl = () => (CFG.apiUrl && !CFG.apiUrl.includes("YOUR-SUBDOMAIN") ? CFG.apiUrl : "");

  const validDate = v => {
    if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return null;
    const d = new Date(v + "T00:00:00Z");
    return isNaN(d) || d.toISOString().slice(0, 10) !== v ? null : v;
  };
  const validTime = v => (typeof v === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(v) ? v : null);

  function today() {
    try {
      return new Intl.DateTimeFormat("en-CA", { timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone }).format(new Date());
    } catch { return new Date().toISOString().slice(0, 10); }
  }

  function blobToBase64(blob) {
    return new Promise((res, rej) => {
      const r = new FileReader();
      r.onload = () => res(String(r.result).split(",")[1]);
      r.onerror = () => rej(new Error("Could not read the audio file."));
      r.readAsDataURL(blob);
    });
  }

  function cleanPlan(data) {
    const raw = Array.isArray(data.tasks) ? data.tasks.slice(0, 20) : [];
    const tasks = [];
    for (const item of raw) {
      if (!item || typeof item !== "object") continue;
      const title = String(item.title ?? "").trim().slice(0, 120);
      if (!title) continue;
      let priority = String(item.priority ?? "medium").toLowerCase();
      if (!["high", "medium", "low"].includes(priority)) priority = "medium";
      const date = validDate(item.date);
      let dur = parseInt(item.duration_min, 10);
      if (isNaN(dur)) dur = 30;
      tasks.push({
        title, priority, date,
        start: date ? validTime(item.start) : null,
        duration_min: Math.max(5, Math.min(dur, 480)),
        note: String(item.note ?? "").trim().slice(0, 200)
      });
    }
    return {
      transcript: String(data.transcript ?? "").trim().slice(0, MAX_CHARS),
      summary: String(data.summary ?? "").trim().slice(0, 300),
      tasks
    };
  }

  function cleanReflection(data) {
    if (data.crisis === true) return CRISIS;
    const feelings = Array.isArray(data.feelings) ? data.feelings : [];
    const reflection = String(data.reflection ?? "").trim().slice(0, 600);
    if (!reflection) throw new Error("The AI response was unreadable. Please try again.");
    return {
      crisis: false,
      transcript: String(data.transcript ?? "").trim().slice(0, MAX_CHARS),
      feelings: feelings.map(x => String(x).trim().slice(0, 40)).filter(Boolean).slice(0, 4),
      reflection,
      reframe: String(data.reframe ?? "").trim().slice(0, 400),
      next_step: String(data.next_step ?? "").trim().slice(0, 300)
    };
  }

  async function run(mode, text, audioBlob) {
    const url = getUrl();
    if (!url) throw new Error("This site isn't configured yet: the owner needs to add the Worker URL in config.js.");
    text = (text || "").trim();
    if (!text && !audioBlob) throw new Error("Please type something or add a voice note first.");
    if (text.length > MAX_CHARS) throw new Error(`Please keep text under ${MAX_CHARS} characters.`);
    if (audioBlob && audioBlob.size > 4 * 1024 * 1024) throw new Error("Audio is too large. Keep it under 4 MB.");
    if (mode === "reflect" && text && CRISIS_RE.test(text)) return CRISIS;

    // For short comma/new-line lists, send the items so each becomes its own task.
    let items = [];
    if (mode === "plan" && text) {
      const pieces = text.split(/[,;\n،、]+/).map(x => x.trim()).filter(Boolean);
      const shortList = pieces.length >= 2 && pieces.every(x => x.split(/\s+/).length <= 6 && !/[.!?]$/.test(x));
      if (shortList) items = pieces;
    }

    const payloadOut = { mode, text, date: today(), items };
    if (audioBlob) {
      payloadOut.audio = {
        mimeType: (audioBlob.type || "audio/webm").split(";")[0].toLowerCase(),
        data: await blobToBase64(audioBlob)
      };
    }

    let resp;
    try {
      resp = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payloadOut)
      });
    } catch {
      throw new Error("Could not reach the server. Check your internet connection.");
    }

    let payload = null;
    try { payload = await resp.json(); } catch {}
    if (!resp.ok || !payload || payload.error) {
      throw new Error((payload && payload.error) || "Something went wrong. Please try again.");
    }

    let data;
    try { data = JSON.parse(String(payload.text).replace(/^```json\s*|```$/g, "").trim()); }
    catch { throw new Error("The AI response was unreadable. Please try again."); }
    if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("The AI response was unreadable. Please try again.");

    return mode === "plan" ? cleanPlan(data) : cleanReflection(data);
  }

  window.FlowGemini = { run };
})();