/**
 * WIRTUALNA DYSPOZYTORNIA MEDYCZNA 999 / CPR 112
 * Architektura: Web Audio API + Gemini Live API + OSM AED
 */

let currentNumber = "";
let isConnected = false;
let webSocket = null;
let audioContext = null; 
let globalGainNode = null; 
let mediaStream = null;
let audioProcessor = null;
let wakeLock = null;
let silenceTimer = null;
let isTransferringCall = false;

let callTimerInterval = null;
let callSeconds = 0;

let nextStartTime = 0;
const SILENCE_TIMEOUT_MS = 6000;

let savedMedicalContext = { systemPrompt: "", detectedModel: "" };

function checkAuth() {
  if (typeof CONFIG === "undefined" || !CONFIG.STATION_PASSWORD) {
    alert("Błąd: Plik config.js nie został załadowany!"); return;
  }
  const inputEl = document.getElementById("pass-input");
  if (inputEl.value.trim() === String(CONFIG.STATION_PASSWORD).trim()) {
    document.getElementById("auth-error").style.display = "none";
    sessionStorage.setItem("station_auth", "true");
    showPhone();
  } else {
    document.getElementById("auth-error").style.display = "block";
    inputEl.value = ""; inputEl.focus();
  }
}

function showPhone() {
  document.getElementById("auth-screen").style.display = "none";
  document.getElementById("phone-screen").style.display = "flex";
}

window.addEventListener("DOMContentLoaded", () => {
  if (sessionStorage.getItem("station_auth") === "true") showPhone();
});

function pressKey(digit) {
  if (isConnected) return;
  if (currentNumber.length < 5) {
    currentNumber += digit;
    document.getElementById("phone-display").innerText = currentNumber;
  }
}

function deleteDigit() {
  if (isConnected) return;
  currentNumber = currentNumber.slice(0, -1);
  document.getElementById("phone-display").innerText = currentNumber;
}

function showError(msg) {
  clearTimeout(silenceTimer);
  clearInterval(callTimerInterval);
  releaseWakeLock();

  const status = document.getElementById("call-status");
  if (status) {
    status.innerText = msg;
    status.style.color = "#f87171";
  }

  isConnected = false;
  setTimeout(endCall, 5000); // 5 sekund na przeczytanie błędu
}

function resetSilenceTimer() {
  clearTimeout(silenceTimer);
  if (!isConnected || isTransferringCall) return;
  let remainingSpeakingTime = 0;
  if (audioContext && nextStartTime > audioContext.currentTime) {
    remainingSpeakingTime = (nextStartTime - audioContext.currentTime) * 1000;
  }
  silenceTimer = setTimeout(() => {
    if (!isConnected || !webSocket || webSocket.readyState !== WebSocket.OPEN || isTransferringCall) return;
    webSocket.send(JSON.stringify({ clientContent: { turns: [{ role: "user", parts: [{ text: "Halo? Nic nie mówię, cisza na linii. Zareaguj natychmiast głosem jako dyspozytor: zawołaj halo czy mnie słychać i ponów swoje pytanie!" }] }], turnComplete: true } }));
  }, remainingSpeakingTime + SILENCE_TIMEOUT_MS);
}

async function requestWakeLock() { try { if ('wakeLock' in navigator) wakeLock = await navigator.wakeLock.request('screen'); } catch (err) {} }
function releaseWakeLock() { if (wakeLock !== null) wakeLock.release().then(() => { wakeLock = null; }); }
document.addEventListener('visibilitychange', async () => { if (document.visibilityState === 'visible' && isConnected) await requestWakeLock(); });

function getUserLocation() {
  return new Promise((resolve) => {
    if (!navigator.geolocation) { resolve(null); return; }
    navigator.geolocation.getCurrentPosition(
      pos => resolve({ lat: pos.coords.latitude, lon: pos.coords.longitude, accuracy: pos.coords.accuracy }),
      err => resolve(null),
      { enableHighAccuracy: true, timeout: 8000, maximumAge: 0 }
    );
  });
}

function calculateDistanceMeters(lat1, lon1, lat2, lon2) {
  const R = 6371e3, φ1 = lat1 * Math.PI / 180, φ2 = lat2 * Math.PI / 180, Δφ = (lat2 - lat1) * Math.PI / 180, Δλ = (lon2 - lon1) * Math.PI / 180;
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
  if (!lat || !lon) return "Brak odczytu GPS zgłaszającego.";
  try {
    const res = await fetch("aed_database.json?v=1");
    if (!res.ok) throw new Error("Brak bazy");
    const elements = (await res.json()).elements || [];
    const MAX_DISTANCE = 800;
    const candidates = elements.filter(el => el.lat || el.center?.lat).map(el => {
      const elLat = el.lat || el.center?.lat, elLon = el.lon || el.center?.lon;
      return { el, lat: elLat, lon: elLon, distance: calculateDistanceMeters(lat, lon, elLat, elLon) };
    }).filter(item => item.distance <= MAX_DISTANCE).sort((a, b) => a.distance - b.distance);

    if (candidates.length === 0) return `W promieniu ${MAX_DISTANCE} m brak AED.`;

    const resolvedPoints = [];
    for (let i = 0; i < candidates.slice(0, 3).length; i++) {
      const tags = candidates[i].el.tags || {};
      let address = tags["addr:street"] ? `ul. ${tags["addr:street"]} ${tags["addr:housenumber"] || ""}${tags["addr:city"] ? `, ${tags["addr:city"]}` : ""}`.trim() : (await reverseGeocode(candidates[i].lat, candidates[i].lon) || "współrzędne");
      resolvedPoints.push(`PUNKT ${i+1}: ok. ${candidates[i].distance}m | Adres: ${address} | Miejsce: ${tags["defibrillator:location"] || tags["description"] || "na ścianie"}`);
    }
    return `ZAREJESTROWANE APARATY AED W OKOLICY:\n${resolvedPoints.join("\n")}`;
  } catch (e) {
    return "Nie udało się ustalić bazy AED.";
  }
}

// Zaktualizowane, odporne na błędy sieciowe wybieranie modelu
async function checkAvailableModels() {
  let fallbackModel = "models/gemini-2.0-flash-exp"; 
  try {
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${CONFIG.GEMINI_API_KEY}`);
    const data = await res.json();
    if (data.models) {
      const bidiModels = data.models.filter(m => m.supportedGenerationMethods?.includes("bidiGenerateContent")).map(m => m.name);
      if (bidiModels.length > 0) {
         return bidiModels.find(m => m.includes("flash")) || bidiModels[0];
      }
    }
  } catch (err) {
    console.warn("Fetch modeli nieudany, używam fallbacku.", err);
  }
  return fallbackModel;
}

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function playWaitMessageSequence(audioFile = "czekaj.mp3", minRep = 2, maxRep = 3) {
  const repeatCount = Math.floor(Math.random() * (maxRep - minRep + 1)) + minRep;
  for (let i = 0; i < repeatCount; i++) {
    if (!isConnected) break;
    await new Promise((resolve) => {
      const waitAudio = new Audio(audioFile);
      waitAudio.onended = resolve; waitAudio.onerror = resolve; waitAudio.play().catch(resolve);
    });
    if (i < repeatCount - 1 && isConnected) await sleep(1000);
  }
}

function formatCallTime(totalSeconds) {
  const m = Math.floor(totalSeconds / 60).toString().padStart(2, '0');
  const s = (totalSeconds % 60).toString().padStart(2, '0');
  return `${m}:${s}`;
}

async function startCall() {
  if (currentNumber !== "999" && currentNumber !== "112") { alert("Wybierz 999 lub 112."); return; }

  document.getElementById("phone-screen").style.display = "none";
  document.getElementById("active-call-screen").style.display = "flex";
  document.getElementById("active-number").innerText = "POŁĄCZENIE ALARMOWE " + currentNumber;

  const status = document.getElementById("call-status");

  clearInterval(callTimerInterval);
  callSeconds = 0;
  if (status) {
    status.style.color = "#ffffff";
    status.innerText = "00:00";
  }

  callTimerInterval = setInterval(() => {
    callSeconds++;
    if (status) status.innerText = formatCallTime(callSeconds);
  }, 1000);

  isConnected = true; isTransferringCall = false; nextStartTime = 0;
  await requestWakeLock();

  try {
    if (!audioContext) {
      audioContext = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 16000 });
      globalGainNode = audioContext.createGain();
      globalGainNode.gain.value = document.querySelector('.action-btn.active-btn').classList.contains('toggled') ? 4.0 : 1.0;
      globalGainNode.connect(audioContext.destination);
    }
    if (audioContext.state === 'suspended') audioContext.resume();
    const unlockSource = audioContext.createBufferSource();
    unlockSource.buffer = audioContext.createBuffer(1, 1, 22050);
    unlockSource.connect(audioContext.destination);
    unlockSource.start(0);
  } catch (e) { showError("Błąd sterownika audio: " + e.message); return; }

  if (!mediaStream) {
    try { mediaStream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, sampleRate: 16000, echoCancellation: true, noiseSuppression: true } }); }
    catch (e) { showError("Brak uprawnień do mikrofonu telefonu."); return; }
  }

  if (audioContext && audioContext.state === 'suspended') audioContext.resume();

  const is112 = (currentNumber === "112");
  const ivrPromise = is112 ? playWaitMessageSequence("czekajcpr.mp3", 2, 4) : playWaitMessageSequence("czekaj.mp3", 2, 3);

  const setupPromise = (async () => {
    try {
      const coords = await getUserLocation();
      let aedContext = coords ? await fetchNearbyAEDs(coords.lat, coords.lon) : "";
      const detectedModel = await checkAvailableModels();
      
      let systemPrompt = "Brak odczytu procedur.";
      try {
        const res = await fetch(`procedury.txt?t=${Date.now()}`, { cache: "no-store" });
        if (res.ok) systemPrompt = await res.text();
      } catch (err) { console.error("Brak pliku procedur."); }

      if (aedContext) systemPrompt += `\n\n[DANE SYSTEMOWE - PUNKTY AED]:\n${aedContext}`;
      return { systemPrompt, detectedModel };
    } catch (e) {
      console.error(e);
      showError("Błąd wew. aplikacji: " + e.message);
      return null;
    }
  })();

  const [_, setupData] = await Promise.all([ivrPromise, setupPromise]);
  if (!isConnected) return; 

  if (!setupData || !setupData.detectedModel) {
    showError("Błąd ładowania silnika AI.");
    return;
  }

  savedMedicalContext = setupData;

  if (is112) {
    await initLiveConnection(`${setupData.systemPrompt}\n\n[AKTUALNA ROLA]: Odbierasz numer 112 jako operator CPR.`, setupData.detectedModel, "cpr");
  } else {
    await initLiveConnection(setupData.systemPrompt, setupData.detectedModel, "medical");
  }
}

async function initLiveConnection(instructions, modelName, callMode = "medical") {
  webSocket = new WebSocket(`wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContent?key=${CONFIG.GEMINI_API_KEY}`);

  const dispatchers = [
    { voice: "Aoede", intro999: "Jesteś dyspozytorką 999. Zgłoś się powitaniem i zapytaj o adres.", intro112: "Jesteś operatorką 112. Zgłoś się powitaniem i pytaj: co się stało?" },
    { voice: "Puck", intro999: "Jesteś dyspozytorem 999. Zgłoś się powitaniem i zapytaj o adres.", intro112: "Jesteś operatorem 112. Zgłoś się powitaniem i pytaj: co się stało?" }
  ];
  const dispatcher = dispatchers[Math.floor(Math.random() * dispatchers.length)];

  webSocket.onopen = () => {
    // ROZWIĄZANIE 1008: Dodano całkowite ominięcie filtrów medycznych/niebezpiecznych
    const setupPayload = {
      model: modelName,
      generationConfig: { responseModalities: ["AUDIO"], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: dispatcher.voice } } } },
      systemInstruction: { parts: [{ text: instructions }] },
      safetySettings: [
        { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_NONE" },
        { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_NONE" },
        { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_NONE" },
        { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_NONE" }
      ]
    };
    if (callMode === "cpr") {
      setupPayload.tools = [{
        functionDeclarations: [{
          name: "przelacz_do_dyspozytora_999", description: "Przekaż rozmowę do dyspozytora medycznego.",
          parameters: { type: "OBJECT", properties: { adres_zdarzenia: { type: "STRING" }, co_sie_stalo: { type: "STRING" } }, required: ["adres_zdarzenia", "co_sie_stalo"] }
        }]
      }];
    }
    webSocket.send(JSON.stringify({ setup: setupPayload }));
  };

  webSocket.onmessage = async (event) => {
    try {
      let data = event.data instanceof Blob ? JSON.parse(await event.data.text()) : JSON.parse(event.data);

      if (data.error) {
        showError("Błąd AI (" + data.error.code + "): " + data.error.message);
        return;
      }

      if (data.setupComplete) {
        // ROZWIĄZANIE 1008: Dodano 250ms opóźnienia, aby uniknąć nakładania się ramek
        setTimeout(() => {
          if (!isConnected || !webSocket || webSocket.readyState !== WebSocket.OPEN) return;
          webSocket.send(JSON.stringify({ clientContent: { turns: [{ role: "user", parts: [{ text: callMode === "cpr" ? dispatcher.intro112 : dispatcher.intro999 }] }], turnComplete: true } }));
          startAudioStreaming();
          resetSilenceTimer();
        }, 250);
        return;
      }

      if (data.serverContent?.modelTurn?.parts) {
        for (const part of data.serverContent.modelTurn.parts) {
          if (part.inlineData?.data) {
            playAudioChunk(part.inlineData.data);
          }
        }
        resetSilenceTimer();
      }

      const functionCalls = data.toolCall?.functionCalls;
      if (functionCalls && callMode === "cpr" && !isTransferringCall) {
        for (const call of functionCalls) {
          if (call.name === "przelacz_do_dyspozytora_999") {
            isTransferringCall = true;
            if (audioProcessor) { audioProcessor.onaudioprocess = null; audioProcessor.disconnect(); audioProcessor = null; }
            handleTransferTo999(call.args?.adres_zdarzenia || "brak", call.args?.co_sie_stalo || "nieokreślone");
            return;
          }
        }
      }
    } catch (err) {
      console.error("Błąd przetwarzania wiadomości WebSocket:", err);
    }
  };

  webSocket.onclose = (e) => {
    // ROZWIĄZANIE: Pobieranie dokładnej przyczyny (jeśli dostępna) do logu na ekranie
    if (isConnected && !isTransferringCall) {
      let reasonText = e.reason ? ` - ${e.reason}` : "";
      showError(`Rozłączono (Kod: ${e.code}${reasonText})`);
    }
  };
}

async function handleTransferTo999(adres, opis) {
  clearTimeout(silenceTimer);
  let wait = audioContext && nextStartTime > audioContext.currentTime ? (nextStartTime - audioContext.currentTime)*1000 + 500 : 1000;
  await sleep(wait);
  if (!isConnected) return;
  if (webSocket) { webSocket.onclose = null; webSocket.close(); webSocket = null; }
  await sleep(1000);
  if (!isConnected) return;
  await playWaitMessageSequence("czekaj.mp3", 1, 1);
  if (!isConnected) return;
  nextStartTime = 0; isTransferringCall = false;

  const prompt999 = `${savedMedicalContext.systemPrompt}\n[KONTEKST]: Przełączono z 112. ADRES: ${adres}, ZDARZENIE: ${opis}.\n[ZADANIE]: Odbierz słowami: "Dyspozytor medyczny 999. Otrzymałem z 112 zgłoszenie dotyczące: ${opis}, pod adresem: ${adres}. Czy ten adres się zgadza?"`;
  await initLiveConnection(prompt999, savedMedicalContext.detectedModel, "medical");
}

function startAudioStreaming() {
  if (audioProcessor) { audioProcessor.disconnect(); audioProcessor = null; }
  if (audioContext.state === 'suspended') audioContext.resume();
  const src = audioContext.createMediaStreamSource(mediaStream);
  audioProcessor = audioContext.createScriptProcessor(4096, 1, 1);
  src.connect(audioProcessor);
  audioProcessor.connect(audioContext.destination);

  audioProcessor.onaudioprocess = (e) => {
    const output = e.outputBuffer.getChannelData(0);
    for (let i = 0; i < output.length; i++) output[i] = 0;
    if (!isConnected || !webSocket || webSocket.readyState !== WebSocket.OPEN || isTransferringCall) return;

    const input = e.inputBuffer.getChannelData(0);

    let sum = 0; for (let i = 0; i < input.length; i++) sum += input[i]*input[i];
    if (Math.sqrt(sum/input.length) > 0.02) resetSilenceTimer();

    const pcm16 = new Int16Array(input.length);
    for (let i=0; i<input.length; i++) pcm16[i] = Math.max(-1, Math.min(1, input[i])) * 0x7fff;
    const bytes = new Uint8Array(pcm16.buffer);
    let bin = ""; for (let i=0; i<bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    webSocket.send(JSON.stringify({ realtimeInput: { mediaChunks: [{ mimeType: "audio/pcm;rate=16000", data: btoa(bin) }] } }));
  };
}

function playAudioChunk(b64) {
  if (!audioContext) return;
  if (audioContext.state === 'suspended') audioContext.resume();

  const bin = atob(b64);
  const pcmLength = Math.floor(bin.length / 2);
  const float32 = new Float32Array(pcmLength);

  for (let i = 0; i < pcmLength; i++) {
    let b1 = bin.charCodeAt(i * 2);
    let b2 = bin.charCodeAt(i * 2 + 1);
    let val = b1 | (b2 << 8);
    if (val & 0x8000) val |= 0xFFFF0000;
    float32[i] = val / 32768.0;
  }

  const buf = audioContext.createBuffer(1, pcmLength, 24000);
  buf.copyToChannel(float32, 0);
  const src = audioContext.createBufferSource();
  src.buffer = buf;

  src.connect(globalGainNode || audioContext.destination);

  if (nextStartTime < audioContext.currentTime) {
    nextStartTime = audioContext.currentTime + 0.15;
  }
  src.start(nextStartTime);
  nextStartTime += buf.duration;
}

function endCall() {
  clearTimeout(silenceTimer);

  clearInterval(callTimerInterval);
  callTimerInterval = null;
  callSeconds = 0;

  isConnected = false; nextStartTime = 0; isTransferringCall = false;

  currentNumber = "";
  document.getElementById("phone-display").innerText = currentNumber;

  document.getElementById("active-call-screen").style.display = "none";
  document.getElementById("phone-screen").style.display = "flex";

  const status = document.getElementById("call-status");
  if (status) {
    status.innerText = "Wybierz numer alarmowy";
    status.style.color = "#9ca3af";
  }

  if (webSocket) { webSocket.onclose = null; webSocket.close(); webSocket = null; }
  if (mediaStream) { mediaStream.getTracks().forEach(t => t.stop()); mediaStream = null; }
  if (audioProcessor) { audioProcessor.disconnect(); audioProcessor = null; }
  releaseWakeLock();
}
