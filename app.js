/**
 * WIRTUALNA DYSPOZYTORNIA MEDYCZNA 999 / CPR 112
 * Architektura: Web Audio API + Gemini Live API + OSM AED + Function Calling
 */

let currentNumber = "";
let isConnected = false;
let webSocket = null;
let audioContext = null;
let mediaStream = null;
let audioProcessor = null;
let wakeLock = null;
let silenceTimer = null;
let isTransferringCall = false; // Globalna flaga blokująca mikrofon w trakcie transferu

let nextStartTime = 0;
const BUFFER_DELAY = 0.25;
const SILENCE_TIMEOUT_MS = 6000;

let savedMedicalContext = { 
  systemPrompt: "", 
  detectedModel: "" 
};

// ==========================================
// 1. WERYFIKACJA HASŁA STACJI (AUTH)
// ==========================================
function checkAuth() {
  if (typeof CONFIG === "undefined" || !CONFIG.STATION_PASSWORD) {
    alert("Błąd: Plik config.js nie został załadowany lub brak parametru STATION_PASSWORD!");
    return;
  }
  const inputEl = document.getElementById("pass-input");
  const entered = inputEl.value.trim(); 
  const expected = String(CONFIG.STATION_PASSWORD).trim(); 
  if (entered === expected) {
    document.getElementById("auth-error").style.display = "none";
    sessionStorage.setItem("station_auth", "true");
    showPhone();
  } else {
    document.getElementById("auth-error").style.display = "block";
    inputEl.value = "";
    inputEl.focus();
  }
}

function showPhone() {
  document.getElementById("auth-screen").style.display = "none";
  document.getElementById("phone-screen").style.display = "flex";
}

window.addEventListener("DOMContentLoaded", () => {
  if (sessionStorage.getItem("station_auth") === "true") showPhone();
});

// ==========================================
// 2. KLAWIATURA I INTERFEJS
// ==========================================
function pressKey(digit) {
  if (isConnected) return;
  if (currentNumber.length < 5) {
    currentNumber += digit;
    updateDisplay();
  }
}

function deleteDigit() {
  if (isConnected) return;
  currentNumber = currentNumber.slice(0, -1);
  updateDisplay();
}

function updateDisplay() {
  document.getElementById("phone-display").innerText = currentNumber;
}

function showError(msg) {
  clearTimeout(silenceTimer);
  releaseWakeLock();
  const status = document.getElementById("call-status");
  status.innerText = msg;
  status.style.color = "#f87171";
  document.getElementById("call-btn").style.display = "flex";
  document.getElementById("hangup-btn").style.display = "none";
  isConnected = false;
}

// ==========================================
// 3. MONITOROWANIE CISZY
// ==========================================
function resetSilenceTimer() {
  clearTimeout(silenceTimer);
  if (!isConnected || isTransferringCall) return;

  let remainingSpeakingTime = 0;
  if (audioContext && nextStartTime > audioContext.currentTime) {
    remainingSpeakingTime = (nextStartTime - audioContext.currentTime) * 1000;
  }
  silenceTimer = setTimeout(() => {
    triggerSilencePrompt();
  }, remainingSpeakingTime + SILENCE_TIMEOUT_MS);
}

function triggerSilencePrompt() {
  if (!isConnected || !webSocket || webSocket.readyState !== WebSocket.OPEN || isTransferringCall) return;
  webSocket.send(JSON.stringify({
    clientContent: {
      turns: [{ role: "user", parts: [{ text: "Halo? Nic nie mówię, cisza na linii. Zareaguj natychmiast głosem jako dyspozytor: zawołaj halo czy mnie słychać i ponów swoje pytanie!" }] }],
      turnComplete: true
    }
  }));
}

// ==========================================
// 4. WAKE LOCK
// ==========================================
async function requestWakeLock() {
  try { if ('wakeLock' in navigator) wakeLock = await navigator.wakeLock.request('screen'); } catch (err) {}
}

function releaseWakeLock() {
  if (wakeLock !== null) wakeLock.release().then(() => { wakeLock = null; });
}

document.addEventListener('visibilitychange', async () => {
  if (document.visibilityState === 'visible' && isConnected) await requestWakeLock();
});

// ==========================================
// 5. GPS I AED
// ==========================================
function getUserLocation() {
  return new Promise((resolve) => {
    if (!navigator.geolocation) { resolve(null); return; }
    navigator.geolocation.getCurrentPosition(
      (pos) => resolve({ lat: pos.coords.latitude, lon: pos.coords.longitude, accuracy: pos.coords.accuracy }),
      (err) => resolve(null),
      { enableHighAccuracy: true, timeout: 8000, maximumAge: 0 }
    );
  });
}

function calculateDistanceMeters(lat1, lon1, lat2, lon2) {
  const R = 6371e3;
  const φ1 = lat1 * Math.PI / 180, φ2 = lat2 * Math.PI / 180;
  const Δφ = (lat2 - lat1) * Math.PI / 180, Δλ = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(Δφ / 2) * Math.sin(Δφ / 2) + Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ / 2) * Math.sin(Δλ / 2);
  return Math.round(R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)));
}

async function reverseGeocode(lat, lon) {
  try {
    const res = await fetch(`https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lon}&zoom=18&addressdetails=1`, { headers: { "Accept-Language": "pl" } });
    const a = (await res.json()).address || {};
    const road = a.road || a.pedestrian || a.suburb || "";
    if (road) return `${road}${a.house_number ? ` ${a.house_number}` : ""}${a.city || a.town || a.village ? `, ${a.city || a.town || a.village}` : ""}`;
    return "Adres z mapy";
  } catch (err) { return null; }
}

async function fetchNearbyAEDs(lat, lon) {
  const status = document.getElementById("call-status");
  if (!lat || !lon) return "Brak odczytu GPS zgłaszającego.";
  status.innerText = "Weryfikacja bazy AED...";
  try {
    const res = await fetch("aed_database.json?v=1");
    if (!res.ok) throw new Error("Brak bazy");
    const elements = (await res.json()).elements || [];
    const MAX_DISTANCE = 800, roughDelta = 0.012;

    const candidates = elements.filter(el => el.lat || el.center?.lat).map(el => {
      const elLat = el.lat || el.center?.lat, elLon = el.lon || el.center?.lon;
      return { el, lat: elLat, lon: elLon, distance: calculateDistanceMeters(lat, lon, elLat, elLon) };
    }).filter(item => item.distance <= MAX_DISTANCE).sort((a, b) => a.distance - b.distance);

    if (candidates.length === 0) return `W promieniu ${MAX_DISTANCE} m brak AED.`;

    status.innerText = `Pobieranie adresu najbliższego AED...`;
    const resolvedPoints = [];
    for (let i = 0; i < candidates.slice(0, 3).length; i++) {
      const item = candidates[i], tags = item.el.tags || {};
      let address = tags["addr:street"] ? `ul. ${tags["addr:street"]} ${tags["addr:housenumber"] || ""}${tags["addr:city"] ? `, ${tags["addr:city"]}` : ""}`.trim() : (await reverseGeocode(item.lat, item.lon) || "współrzędne");
      resolvedPoints.push(`PUNKT ${i+1}: ok. ${item.distance}m | Adres: ${address} | Miejsce: ${tags["defibrillator:location"] || tags["description"] || "na ścianie"}`);
    }
    status.innerText = `Znaleziono AED w pobliżu!`;
    return `ZAREJESTROWANE APARATY AED W OKOLICY:\n${resolvedPoints.join("\n")}`;
  } catch (e) {
    status.innerText = "Błąd bazy AED."; return "Nie udało się ustalić bazy AED.";
  }
}

// ==========================================
// 6. MODELE I ZAPOWIEDZI
// ==========================================
async function checkAvailableModels() {
  try {
    const data = await (await fetch(`https://generativelanguage.googleapis.com/v1alpha/models?key=${CONFIG.GEMINI_API_KEY}`)).json();
    if (data.error) { showError(data.error.message); return null; }
    const bidiModels = data.models?.filter(m => m.supportedGenerationMethods?.includes("bidiGenerateContent")).map(m => m.name);
    return bidiModels ? (bidiModels.find(m => m.includes("flash")) || bidiModels[0]) : null;
  } catch (err) { showError(err.message); return null; }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function playWaitMessageSequence(audioFile = "czekaj.mp3", minRep = 2, maxRep = 3, label = "centralą 999") {
  const status = document.getElementById("call-status");
  const repeatCount = Math.floor(Math.random() * (maxRep - minRep + 1)) + minRep;
  for (let i = 0; i < repeatCount; i++) {
    if (!isConnected) break;
    status.innerText = `Łączenie z ${label}... (${i + 1}/${repeatCount})`;
    status.style.color = "#fbbf24";
    await new Promise((resolve) => {
      const waitAudio = new Audio(audioFile);
      waitAudio.onended = resolve; waitAudio.onerror = resolve; waitAudio.play().catch(resolve);
    });
    if (i < repeatCount - 1 && isConnected) await sleep(1000);
  }
}

// ==========================================
// 8. ROZPOCZĘCIE POŁĄCZENIA
// ==========================================
async function startCall() {
  if (currentNumber !== "999" && currentNumber !== "112") { showError("Wybierz 999 lub 112."); return; }
  
  document.getElementById("call-btn").style.display = "none";
  document.getElementById("hangup-btn").style.display = "flex";
  isConnected = true;
  isTransferringCall = false; // Reset flagi transferu
  nextStartTime = 0;
  await requestWakeLock();

  if (!audioContext) {
    try {
      audioContext = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 24000 });
      if (audioContext.state === 'suspended') await audioContext.resume();
    } catch (e) { showError("Błąd AudioContext: " + e.message); return; }
  }

  if (!mediaStream) {
    try {
      mediaStream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, sampleRate: 16000, echoCancellation: true, noiseSuppression: true } });
    } catch (e) { showError("Brak uprawnień do mikrofonu."); return; }
  }

  const is112 = (currentNumber === "112");
  const ivrPromise = is112 ? playWaitMessageSequence("czekajcpr.mp3", 2, 4, "operatorem 112 (CPR)") : playWaitMessageSequence("czekaj.mp3", 2, 3, "centralą 999");
  
  const setupPromise = (async () => {
    const coords = await getUserLocation();
    let aedContext = coords ? await fetchNearbyAEDs(coords.lat, coords.lon) : "";
    const detectedModel = await checkAvailableModels();
    if (!detectedModel) return null;
    let systemPrompt = await (await fetch(`procedury.txt?t=${Date.now()}`, { cache: "no-store" })).text();
    if (aedContext) systemPrompt += `\n\n[DANE SYSTEMOWE - PUNKTY AED]:\n${aedContext}`;
    return { systemPrompt, detectedModel };
  })();

  const [_, setupData] = await Promise.all([ivrPromise, setupPromise]);
  if (!isConnected) return;
  if (!setupData || !setupData.detectedModel) { showError("Błąd połączenia ze stacją AI."); return; }
  
  savedMedicalContext = setupData;

  if (is112) {
    await initLiveConnection(`${setupData.systemPrompt}\n\n[AKTUALNA ROLA]: Odbierasz numer 112 jako operator CPR.`, setupData.detectedModel, "cpr");
  } else {
    await initLiveConnection(setupData.systemPrompt, setupData.detectedModel, "medical");
  }
}

// ==========================================
// 9. WEBSOCKET GEMINI LIVE API
// ==========================================
async function initLiveConnection(instructions, modelName, callMode = "medical") {
  const status = document.getElementById("call-status");
  status.innerText = callMode === "cpr" ? "Łączenie z operatorem 112..." : "Łączenie z dyspozytorem 999...";
  status.style.color = "#fbbf24";

  webSocket = new WebSocket(`wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContent?key=${CONFIG.GEMINI_API_KEY}`);
  const dispatchers = [
    { voice: "Kore", intro999: "Jesteś dyspozytorką 999. Zgłoś się powitaniem i zapytaj o adres.", intro112: "Jesteś operatorką 112. Zgłoś się powitaniem i pytaj: co się stało?" },
    { voice: "Fenrir", intro999: "Jesteś dyspozytorem 999. Zgłoś się powitaniem i zapytaj o adres.", intro112: "Jesteś operatorem 112. Zgłoś się powitaniem i pytaj: co się stało?" }
  ];
  const dispatcher = dispatchers[Math.floor(Math.random() * dispatchers.length)];

  webSocket.onopen = () => {
    status.innerText = "Autoryzacja połączenia AI...";
    const setupPayload = {
      model: modelName,
      generationConfig: { responseModalities: ["AUDIO"], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: dispatcher.voice } } } },
      systemInstruction: { parts: [{ text: instructions }] }
    };

    if (callMode === "cpr") {
      setupPayload.tools = [{
        functionDeclarations: [{
          name: "przelacz_do_dyspozytora_999",
          description: "Przekaż rozmowę do dyspozytora medycznego. Wymaga zebranego adresu i opisu zdarzenia.",
          parameters: {
            type: "OBJECT",
            properties: { adres_zdarzenia: { type: "STRING", description: "Dokładny adres zdarzenia" }, co_sie_stalo: { type: "STRING", description: "Krótki opis zgłoszenia" } },
            required: ["adres_zdarzenia", "co_sie_stalo"]
          }
        }]
      }];
    }
    webSocket.send(JSON.stringify({ setup: setupPayload }));
  };
  
  webSocket.onmessage = async (event) => {
    try {
      let data = event.data instanceof Blob ? JSON.parse(await event.data.text()) : JSON.parse(event.data);
      
      if (data.setupComplete) {
        status.innerText = callMode === "cpr" ? "112 połączone. Zgłasza się CPR..." : "999 połączone. Dyspozytor na linii...";
        status.style.color = "#4ade80";
        webSocket.send(JSON.stringify({ clientContent: { turns: [{ role: "user", parts: [{ text: callMode === "cpr" ? dispatcher.intro112 : dispatcher.intro999 }] }], turnComplete: true } }));
        startAudioStreaming();
        resetSilenceTimer();
        return;
      }

      if (data.serverContent?.modelTurn?.parts) {
        for (const part of data.serverContent.modelTurn.parts) if (part.inlineData?.data) playAudioChunk(part.inlineData.data);
        resetSilenceTimer();
      }
      
      const functionCalls = data.toolCall?.functionCalls;
      if (functionCalls && callMode === "cpr" && !isTransferringCall) {
        for (const call of functionCalls) {
          if (call.name === "przelacz_do_dyspozytora_999") {
            isTransferringCall = true;
            
            // NATYCHMIASTOWE ZABLOKOWANIE WYSYŁANIA AUDIO DO API
            if (audioProcessor) {
              audioProcessor.onaudioprocess = null;
              audioProcessor.disconnect();
              audioProcessor = null;
            }

            const adres = call.args?.adres_zdarzenia || "brak dokładnego adresu";
            const opis = call.args?.co_sie_stalo || "nieokreślone zdarzenie";
            handleTransferTo999(adres, opis);
            return;
          }
        }
      }
    } catch (err) {}
  };

  webSocket.onclose = (e) => { 
    if (isConnected && !isTransferringCall) showError(`Rozłączono (${e.code})`); 
  };
}

// ==========================================
// 10. TRANSFER CPR -> 999
// ==========================================
async function handleTransferTo999(adres, opis) {
  clearTimeout(silenceTimer);
  
  // Pozwalamy głośnikowi dokończyć odtwarzanie ostatniego zdania operatora 112
  let wait = audioContext && nextStartTime > audioContext.currentTime ? (nextStartTime - audioContext.currentTime)*1000 + 500 : 1000;
  await sleep(wait);
  if (!isConnected) return;

  if (webSocket) { webSocket.onclose = null; webSocket.close(); webSocket = null; }
  await sleep(1000);
  if (!isConnected) return;

  await playWaitMessageSequence("czekaj.mp3", 1, 1, "999");
  if (!isConnected) return;

  nextStartTime = 0;
  isTransferringCall = false; // Odblokowanie do nowej sesji medycznej
  
  const prompt999 = `${savedMedicalContext.systemPrompt}
[KONTEKST]: Przełączono z 112. Operator przekazał formatkę: ADRES: ${adres}, ZDARZENIE: ${opis}.
[ZADANIE]: Odbierz słowami: "Dyspozytor medyczny 999. Otrzymałem z 112 zgłoszenie dotyczące: ${opis}, pod adresem: ${adres}. Czy ten adres się zgadza?" Po potwierdzeniu natychmiast pogłęb wywiad medyczny.`;

  await initLiveConnection(prompt999, savedMedicalContext.detectedModel, "medical");
}

// ==========================================
// 11. AUDIO OUT (Do serwera)
// ==========================================
function startAudioStreaming() {
  if (audioProcessor) { audioProcessor.disconnect(); audioProcessor = null; }
  const ctx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 16000 });
  const src = ctx.createMediaStreamSource(mediaStream);
  audioProcessor = ctx.createScriptProcessor(4096, 1, 1);
  src.connect(audioProcessor);
  audioProcessor.connect(ctx.destination);

  audioProcessor.onaudioprocess = (e) => {
    // BLOKADA WYSYŁANIA DANYCH JEŚLI TRWA TRANSFER
    if (!isConnected || !webSocket || webSocket.readyState !== WebSocket.OPEN || isTransferringCall) return;
    
    const input = e.inputBuffer.getChannelData(0);
    let sum = 0;
    for (let i = 0; i < input.length; i++) sum += input[i]*input[i];
    if (Math.sqrt(sum/input.length) > 0.05) resetSilenceTimer();
    
    const pcm16 = new Int16Array(input.length);
    for (let i=0; i<input.length; i++) pcm16[i] = Math.max(-1, Math.min(1, input[i])) * 0x7fff;
    const bytes = new Uint8Array(pcm16.buffer);
    let bin = "";
    for (let i=0; i<bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    
    webSocket.send(JSON.stringify({ realtimeInput: { mediaChunks: [{ mimeType: "audio/pcm;rate=16000", data: btoa(bin) }] } }));
  };
}

// ==========================================
// 12. AUDIO IN (Z serwera)
// ==========================================
function playAudioChunk(b64) {
  if (!audioContext) return;
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i=0; i<bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const float32 = new Float32Array(new Int16Array(bytes.buffer).length);
  for (let i=0; i<float32.length; i++) float32[i] = new Int16Array(bytes.buffer)[i] / 32768.0;
  
  const buf = audioContext.createBuffer(1, float32.length, 24000);
  buf.copyToChannel(float32, 0);
  const src = audioContext.createBufferSource();
  src.buffer = buf;
  src.connect(audioContext.destination);
  
  if (nextStartTime <= audioContext.currentTime) nextStartTime = audioContext.currentTime + BUFFER_DELAY;
  src.start(nextStartTime);
  nextStartTime += buf.duration;
}

// ==========================================
// 13. ZAKOŃCZENIE POŁĄCZENIA
// ==========================================
function endCall() {
  clearTimeout(silenceTimer);
  isConnected = false; currentNumber = ""; nextStartTime = 0; isTransferringCall = false;
  updateDisplay();
  if (webSocket) { webSocket.onclose = null; webSocket.close(); webSocket = null; }
  if (mediaStream) { mediaStream.getTracks().forEach(t => t.stop()); mediaStream = null; }
  if (audioProcessor) { audioProcessor.disconnect(); audioProcessor = null; }
  document.getElementById("call-status").innerText = "Połączenie zakończone.";
  document.getElementById("call-status").style.color = "#9ca3af";
  document.getElementById("call-btn").style.display = "flex";
  document.getElementById("hangup-btn").style.display = "none";
  releaseWakeLock();
}
