/**
 * WIRTUALNA DYSPOZYTORNIA MEDYCZNA 999 / CPR 112
 * Architektura: Web Audio API + Gemini Live API (BidiGenerateContent) + OSM AED + Function Calling
 */

// ==========================================
// ZMIENNE STANU I STAŁE SYSTEMOWE
// ==========================================
let currentNumber = "";
let isConnected = false;
let webSocket = null;
let audioContext = null;
let mediaStream = null;
let audioProcessor = null;
let wakeLock = null;
let silenceTimer = null;

// Buforowanie dźwięku i timery
let nextStartTime = 0;
const BUFFER_DELAY = 0.25;
const SILENCE_TIMEOUT_MS = 6000;

// Pamięć podręczna procedur i modelu na wypadek transferu z 112 do 999
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
  if (sessionStorage.getItem("station_auth") === "true") {
    showPhone();
  }
});

// ==========================================
// 2. KLAWIATURA I INTERFEJS UŻYTKOWNIKA
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
// 3. MONITOROWANIE CISZY (SILENCE DETECTOR)
// ==========================================
function resetSilenceTimer() {
  clearTimeout(silenceTimer);
  if (!isConnected) return;

  let remainingSpeakingTime = 0;
  if (audioContext && nextStartTime > audioContext.currentTime) {
    remainingSpeakingTime = (nextStartTime - audioContext.currentTime) * 1000;
  }

  silenceTimer = setTimeout(() => {
    triggerSilencePrompt();
  }, remainingSpeakingTime + SILENCE_TIMEOUT_MS);
}

function triggerSilencePrompt() {
  if (!isConnected || !webSocket || webSocket.readyState !== WebSocket.OPEN) return;

  console.log("Wykryto brak odpowiedzi — wymuszenie ponaglenia ze strony dyspozytora.");

  webSocket.send(JSON.stringify({
    clientContent: {
      turns: [
        {
          role: "user",
          parts: [{ text: "Halo? Nic nie mówię, cisza na linii. Zareaguj natychmiast głosem jako dyspozytor: zawołaj halo czy mnie słychać i ponów swoje pytanie!" }]
        }
      ],
      turnComplete: true
    }
  }));
}

// ==========================================
// 4. BLOKADA WYGASZANIA EKRANU (WAKE LOCK)
// ==========================================
async function requestWakeLock() {
  try {
    if ('wakeLock' in navigator) {
      wakeLock = await navigator.wakeLock.request('screen');
      console.log("Ekran zabezpieczony przed wygaszeniem.");
    }
  } catch (err) {
    console.warn(`Błąd Wake Lock: ${err.name}, ${err.message}`);
  }
}

function releaseWakeLock() {
  if (wakeLock !== null) {
    wakeLock.release().then(() => {
      wakeLock = null;
      console.log("Blokada wygaszania zwolniona.");
    });
  }
}

document.addEventListener('visibilitychange', async () => {
  if (document.visibilityState === 'visible' && isConnected) {
    await requestWakeLock();
  }
});

// ==========================================
// 5. GEOLOKALIZACJA I BAZA POBIERANIA AED
// ==========================================
function getUserLocation() {
  return new Promise((resolve) => {
    if (!navigator.geolocation) {
      console.warn("Geolokalizacja niedostępna w przeglądarce.");
      resolve(null);
      return;
    }

    navigator.geolocation.getCurrentPosition(
      (pos) => {
        resolve({ 
          lat: pos.coords.latitude, 
          lon: pos.coords.longitude, 
          accuracy: pos.coords.accuracy 
        });
      },
      (err) => {
        resolve(null);
      },
      { 
        enableHighAccuracy: true,
        timeout: 8000,
        maximumAge: 0
      }
    );
  });
}

function calculateDistanceMeters(lat1, lon1, lat2, lon2) {
  const R = 6371e3;
  const φ1 = lat1 * Math.PI / 180;
  const φ2 = lat2 * Math.PI / 180;
  const Δφ = (lat2 - lat1) * Math.PI / 180;
  const Δλ = (lon2 - lon1) * Math.PI / 180;

  const a = Math.sin(Δφ / 2) * Math.sin(Δφ / 2) +
            Math.cos(φ1) * Math.cos(φ2) *
            Math.sin(Δλ / 2) * Math.sin(Δλ / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

  return Math.round(R * c);
}

async function reverseGeocode(lat, lon) {
  try {
    const res = await fetch(`https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lon}&zoom=18&addressdetails=1`, {
      headers: { "Accept-Language": "pl" }
    });
    const data = await res.json();
    const a = data.address || {};
    
    const road = a.road || a.pedestrian || a.suburb || "";
    const house = a.house_number ? ` ${a.house_number}` : "";
    const city = a.city || a.town || a.village || "";
    
    if (road) {
      return `${road}${house}${city ? `, ${city}` : ""}`;
    }
    return data.display_name?.split(",").slice(0, 2).join(",") || "Adres z mapy";
  } catch (err) {
    return null;
  }
}

async function fetchNearbyAEDs(lat, lon) {
  const status = document.getElementById("call-status");
  if (!lat || !lon) {
    status.innerText = "Brak odczytu GPS.";
    return "Brak odczytu GPS zgłaszającego. Wskaż typowy punkt w pobliżu.";
  }

  status.innerText = "Weryfikacja bazy AED...";

  try {
    const res = await fetch("aed_database.json?v=1");
    if (!res.ok) throw new Error("Brak pliku aed_database.json");
    
    const data = await res.json();
    const elements = data.elements || [];
    const MAX_DISTANCE = 800; 
    const roughDelta = 0.012;

    const candidates = elements
      .filter(el => {
        const elLat = el.lat || el.center?.lat;
        const elLon = el.lon || el.center?.lon;
        return elLat && elLon &&
          Math.abs(elLat - lat) < roughDelta &&
          Math.abs(elLon - lon) < roughDelta;
      })
      .map(el => {
        const elLat = el.lat || el.center?.lat;
        const elLon = el.lon || el.center?.lon;
        return {
          el,
          lat: elLat,
          lon: elLon,
          distance: calculateDistanceMeters(lat, lon, elLat, elLon)
        };
      })
      .filter(item => item.distance <= MAX_DISTANCE)
      .sort((a, b) => a.distance - b.distance);

    if (candidates.length === 0) {
      status.innerText = `Brak AED w promieniu ${MAX_DISTANCE}m`;
      return `W promieniu ${MAX_DISTANCE} m nie ma zarejestrowanych aparatów AED. Poinformuj zgłaszającego, że w pobliżu nie ma defibrylatora i nakaż skupić się na ciągłym uciskaniu klatki piersiowej.`;
    }

    status.innerText = `Pobieranie adresu najbliższego AED...`;
    const topCandidates = candidates.slice(0, 3);
    const resolvedPoints = [];

    for (let i = 0; i < topCandidates.length; i++) {
      const item = topCandidates[i];
      const tags = item.el.tags || {};
      const placeName = tags["name"] || tags["operator"] || "Budynek użyteczności publicznej";
      const placementDesc = tags["defibrillator:location"] || tags["description"] || "na ścianie / przy wejściu";
      
      let address = "";
      if (tags["addr:street"]) {
        address = `ul. ${tags["addr:street"]} ${tags["addr:housenumber"] || ""}`.trim();
        if (tags["addr:city"]) address += `, ${tags["addr:city"]}`;
      } else {
        const fetchedAddress = await reverseGeocode(item.lat, item.lon);
        address = fetchedAddress ? fetchedAddress : "współrzędne terenu";
      }

      resolvedPoints.push({
        num: i + 1,
        distance: item.distance,
        address: address,
        placeName: placeName,
        placementDesc: placementDesc
      });
    }

    status.innerText = `Znaleziono AED w pobliżu!`;
    const formattedList = resolvedPoints.map(p => 
      `PUNKT ${p.num}${p.num === 1 ? ' (Najbliższy)' : ''}: Odległość: ok. ${p.distance} m | Adres: ${p.address} | Nazwa: ${p.placeName} | Dokładne miejsce: ${p.placementDesc}`
    ).join("\n");

    return `ZAREJESTROWANE APARATY AED W OKOLICY:\n${formattedList}`;

  } catch (e) {
    status.innerText = "Błąd bazy lokalnej!";
    return "Nie udało się ustalić bazy AED. Wskaż typowy punkt zastępczy.";
  }
}

// ==========================================
// 6. WERYFIKACJA MODELI GEMINI LIVE API
// ==========================================
async function checkAvailableModels() {
  const status = document.getElementById("call-status");
  status.innerText = "Weryfikacja modeli Live API...";
  status.style.color = "#fbbf24";

  try {
    const res = await fetch(`https://generativelanguage.googleapis.com/v1alpha/models?key=${CONFIG.GEMINI_API_KEY}`);
    const data = await res.json();

    if (data.error) {
      showError("Błąd klucza Google API: " + data.error.message);
      return null;
    }

    const bidiModels = data.models
      ?.filter(m => m.supportedGenerationMethods && m.supportedGenerationMethods.includes("bidiGenerateContent"))
      .map(m => m.name);

    if (bidiModels && bidiModels.length > 0) {
      return bidiModels.find(m => m.includes("flash")) || bidiModels[0];
    } else {
      showError("Twój klucz nie ma włączonej obsługi dwukierunkowego Live API.");
      return null;
    }
  } catch (err) {
    showError("Błąd sieci podczas sprawdzania modeli: " + err.message);
    return null;
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ==========================================
// 7. ZAPOWIEDZI IVR (CZEKAJ NA POŁĄCZENIE)
// ==========================================
async function playWaitMessageSequence(audioFile = "czekaj.mp3", minRep = 2, maxRep = 3, label = "centralą 999") {
  const status = document.getElementById("call-status");
  const repeatCount = Math.floor(Math.random() * (maxRep - minRep + 1)) + minRep;

  for (let i = 0; i < repeatCount; i++) {
    if (!isConnected) break;

    status.innerText = `Łączenie z ${label}... (${i + 1}/${repeatCount})`;
    status.style.color = "#fbbf24";

    await new Promise((resolve) => {
      const waitAudio = new Audio(audioFile);
      waitAudio.onended = resolve;
      waitAudio.onerror = () => {
        resolve();
      };
      waitAudio.play().catch(() => resolve());
    });

    if (i < repeatCount - 1 && isConnected) {
      await sleep(1000);
    }
  }
}

// ==========================================
// 8. ROZPOCZĘCIE POŁĄCZENIA (999 / 112)
// ==========================================
async function startCall() {
  if (currentNumber !== "999" && currentNumber !== "112") {
    showError("Niepoprawny numer. Wybierz 999 lub 112.");
    return;
  }

  const is112 = (currentNumber === "112");
  document.getElementById("call-btn").style.display = "none";
  document.getElementById("hangup-btn").style.display = "flex";
  isConnected = true;
  nextStartTime = 0;
  await requestWakeLock();

  const ivrPromise = is112 
    ? playWaitMessageSequence("czekajcpr.mp3", 2, 4, "operatorem 112 (CPR)")
    : playWaitMessageSequence("czekaj.mp3", 2, 3, "centralą 999");

  const setupPromise = (async () => {
    const coords = await getUserLocation();
    let aedContext = "";
    if (coords) {
      aedContext = await fetchNearbyAEDs(coords.lat, coords.lon);
    }

    const detectedModel = await checkAvailableModels();
    if (!detectedModel) return null;

    const rulesRes = await fetch(`procedury.txt?t=${Date.now()}`, { cache: "no-store" });
    let systemPrompt = await rulesRes.text();

    if (aedContext) {
      systemPrompt += `\n\n[DANE SYSTEMOWE DYSPYZYTORA - PUNKTY AED]:\n${aedContext}\nUżyj tych konkretnych punktów, instruując świadka o wysłaniu kogoś po AED.`;
    }

    return { systemPrompt, detectedModel };
  })();

  const [_, setupData] = await Promise.all([ivrPromise, setupPromise]);

  if (!isConnected) return;

  if (!setupData || !setupData.detectedModel) {
    showError("Nie udało się połączyć ze stacją.");
    return;
  }

  savedMedicalContext = setupData;

  if (is112) {
    const cprPrompt = `${setupData.systemPrompt}\n\n[AKTUALNA ROLA]: Odbierasz numer 112 jako operator CPR. Zgłoś się natychmiast, zbierz wstępne dane i po ich zebraniu powiedz o przełączeniu do dyspozytora medycznego.`;
    await initLiveConnection(cprPrompt, setupData.detectedModel, "cpr");
  } else {
    await initLiveConnection(setupData.systemPrompt, setupData.detectedModel, "medical");
  }
}

// ==========================================
// 9. POŁĄCZENIE WEBSOCKET Z GEMINI LIVE
// ==========================================
async function initLiveConnection(instructions, modelName, callMode = "medical") {
  const status = document.getElementById("call-status");
  status.innerText = callMode === "cpr" ? "Łączenie z operatorem 112..." : "Łączenie z dyspozytorem 999...";
  status.style.color = "#fbbf24";

  if (!audioContext) {
    try {
      audioContext = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 24000 });
      if (audioContext.state === 'suspended') {
        await audioContext.resume();
      }
    } catch (e) {
      showError("Błąd AudioContext: " + e.message);
      return;
    }
  }

  if (!mediaStream) {
    try {
      mediaStream = await navigator.mediaDevices.getUserMedia({ 
        audio: {
          channelCount: 1,
          sampleRate: 16000,
          echoCancellation: true,
          noiseSuppression: true
        } 
      });
    } catch (e) {
      showError("Brak uprawnień do mikrofonu. Zezwól na dostęp!");
      return;
    }
  }

  const uri = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContent?key=${CONFIG.GEMINI_API_KEY}`;
  webSocket = new WebSocket(uri);

  webSocket.onopen = () => {
    status.innerText = callMode === "cpr" 
      ? "Połączenie 112 odebrane. Zgłasza się CPR..." 
      : "Połączenie 999 odebrane. Dyspozytor na linii...";
    status.style.color = "#4ade80";

    const dispatchers = [
      { 
        voice: "Kore", 
        intro999: "Odbierasz połączenie 999 jako dyspozytorka medyczna. Zgłoś się oficjalnym powitaniem i zapytaj o adres zdarzenia. Używaj nienagannej polszczyzny.",
        intro112: "Odbierasz połączenie 112 jako operatorka CPR. Zgłoś się oficjalnym powitaniem. Pamiętaj, aby ZAWSZE pytać poprawnie: 'co się stało?', nigdy inaczej."
      },
      { 
        voice: "Fenrir", 
        intro999: "Odbierasz połączenie 999 jako dyspozytor medyczny. Zgłoś się oficjalnym powitaniem i zapytaj o adres zdarzenia. Używaj nienagannej polszczyzny.",
        intro112: "Odbierasz połączenie 112 jako operator CPR. Zgłoś się oficjalnym powitaniem. Pamiętaj, aby ZAWSZE pytać poprawnie: 'co się stało?', nigdy inaczej."
      }
    ];

    const currentDispatcher = dispatchers[Math.floor(Math.random() * dispatchers.length)];

    const setupPayload = {
      model: modelName,
      generationConfig: {
        responseModalities: ["AUDIO", "TEXT"], // <-- TUTAJ MUSI BYĆ TEXT, ABY PRZYCISK ZADZIAŁAŁ
        speechConfig: {
            prebuiltVoiceConfig: { voiceName: currentDispatcher.voice }
          }
        }
      },
      systemInstruction: {
        parts: [{ text: instructions }]
      }
    };

    // Wirtualny przycisk wywoływany przez operatora 112 wraz z przekazaniem zebranych danych
    if (callMode === "cpr") {
      setupPayload.tools = [
        {
          functionDeclarations: [
            {
              name: "przelacz_do_dyspozytora_999",
              description: "Wywołaj, aby przekazać rozmowę do dyspozytora medycznego. Musisz przekazać ustalony adres i rodzaj zdarzenia.",
              parameters: {
                type: "OBJECT",
                properties: {
                  adres_zdarzenia: { type: "STRING", description: "Dokładny adres zdarzenia ustalony podczas wywiadu" },
                  co_sie_stalo: { type: "STRING", description: "Krótki opis zgłoszenia (np. potrącenie, zawał, upadek)" }
                },
                required: ["adres_zdarzenia", "co_sie_stalo"]
              }
            }
          ]
        }
      ];
    }

    webSocket.send(JSON.stringify({ setup: setupPayload }));

    const initialPrompt = (callMode === "cpr") ? currentDispatcher.intro112 : currentDispatcher.intro999;
    webSocket.send(JSON.stringify({
      clientContent: {
        turns: [
          {
            role: "user",
            parts: [{ text: initialPrompt }]
          }
        ],
        turnComplete: true
      }
    }));

    startAudioStreaming();
    resetSilenceTimer();
  };

  let isTransferring = false;

  webSocket.onmessage = async (event) => {
    try {
      let data;
      if (event.data instanceof Blob) {
        data = JSON.parse(await event.data.text());
      } else {
        data = JSON.parse(event.data);
      }

      // 1. Odtwarzanie głosu z głośnika
      if (data.serverContent?.modelTurn?.parts) {
        for (const part of data.serverContent.modelTurn.parts) {
          if (part.inlineData?.data) {
            playAudioChunk(part.inlineData.data);
          }
        }
        resetSilenceTimer();
      }

      // 2. Nasłuchiwanie na wciśnięcie przycisku przez AI (Tool Call) z pobraniem danych
      const functionCalls = data.toolCall?.functionCalls;
      if (functionCalls && callMode === "cpr" && !isTransferring) {
        for (const call of functionCalls) {
          if (call.name === "przelacz_do_dyspozytora_999") {
            isTransferring = true;
            
            const zebranyAdres = call.args?.adres_zdarzenia || "brak dokładnego adresu";
            const zebranyOpis = call.args?.co_sie_stalo || "nieokreślone zdarzenie";
            
            console.log(`Formatka z 112 -> Adres: ${zebranyAdres} | Zdarzenie: ${zebranyOpis}`);
            handleTransferTo999(zebranyAdres, zebranyOpis);
            return;
          }
        }
      }
    } catch (err) {
      console.error("Błąd parsowania pakietu WebSocket:", err);
    }
  };

  webSocket.onerror = (err) => {
    showError("Błąd gniazda WebSocket.");
  };

  webSocket.onclose = (event) => {
    if (isConnected && callMode !== "transferring") {
      showError(`Rozłączono (Kod: ${event.code})`);
    }
  };
}

// ==========================================
// 10. TRANSFER POŁĄCZENIA: CPR (112) -> 999
// ==========================================
async function handleTransferTo999(przekazanyAdres = "", przekazanyOpis = "") {
  clearTimeout(silenceTimer);

  let waitTime = 1000;
  if (audioContext && nextStartTime > audioContext.currentTime) {
    waitTime = (nextStartTime - audioContext.currentTime) * 1000 + 500;
  }
  await sleep(waitTime);

  if (!isConnected) return;

  if (webSocket) {
    webSocket.onclose = null;
    webSocket.close();
    webSocket = null;
  }

  await sleep(1000);
  if (!isConnected) return;

  await playWaitMessageSequence("czekaj.mp3", 1, 1, "Dyspozytorem Medycznym 999");

  if (!isConnected) return;

  // Start właściwej sesji medycznej z danymi z 112
  nextStartTime = 0;
  const prompt999 = `${savedMedicalContext.systemPrompt}

[KONTEKST SYSTEMOWY]: Świadek został przełączony z numeru 112. Operator 112 zebrał wstępny wywiad i przekazał w systemie SWD następującą formatkę:
- ZGŁOSZONY ADRES: ${przekazanyAdres}
- POWÓD WEZWANIA (co się stało): ${przekazanyOpis}

[TWOJE ZADANIE JAKO DYSPOZYTOR 999]:
1. Odbierz połączenie używając dokładnie tego schematu: "Dyspozytor medyczny 999, słucham. Otrzymałem z 112 zgłoszenie dotyczące: ${przekazanyOpis}, pod adresem: ${przekazanyAdres}. Czy ten adres się zgadza?"
2. Następnie natychmiast POGŁĘB wywiad medyczny. Zapytaj o szczegóły kliniczne, których brakuje w formatce (np. czy pacjent jest przytomny, czy oddycha prawidłowo, wiek, czy mocno krwawi).
3. Przejdź do standardowej procedury (instrukcje pierwszej pomocy, wysłanie zespołu).`;

  await initLiveConnection(prompt999, savedMedicalContext.detectedModel, "medical");
}

// ==========================================
// 11. STRUMIENIOWANIE AUDIO Z MIKROFONU
// ==========================================
function startAudioStreaming() {
  if (audioProcessor) {
    audioProcessor.disconnect();
    audioProcessor = null;
  }

  const inputAudioCtx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 16000 });
  const source = inputAudioCtx.createMediaStreamSource(mediaStream);
  
  audioProcessor = inputAudioCtx.createScriptProcessor(4096, 1, 1);
  source.connect(audioProcessor);
  audioProcessor.connect(inputAudioCtx.destination);

  audioProcessor.onaudioprocess = (e) => {
    if (!isConnected || !webSocket || webSocket.readyState !== WebSocket.OPEN) return;
    
    const inputData = e.inputBuffer.getChannelData(0);
    
    let sum = 0;
    for (let i = 0; i < inputData.length; i++) sum += inputData[i] * inputData[i];
    const rms = Math.sqrt(sum / inputData.length);
    if (rms > 0.05) {
      resetSilenceTimer();
    }

    const pcm16 = new Int16Array(inputData.length);
    for (let i = 0; i < inputData.length; i++) {
      pcm16[i] = Math.max(-1, Math.min(1, inputData[i])) * 0x7fff;
    }
    
    const bytes = new Uint8Array(pcm16.buffer);
    let binary = "";
    for (let i = 0; i < bytes.byteLength; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    const base64Audio = btoa(binary);

    webSocket.send(JSON.stringify({
      realtimeInput: {
        mediaChunks: [{ mimeType: "audio/pcm;rate=16000", data: base64Audio }]
      }
    }));
  };
}

// ==========================================
// 12. ODTWARZANIE MOWY DYSPOZYTORA (BUFOR)
// ==========================================
function playAudioChunk(base64Data) {
  if (!audioContext) return;

  const binaryString = atob(base64Data);
  const bytes = new Uint8Array(binaryString.length);
  for (let i = 0; i < binaryString.length; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }

  const pcm16 = new Int16Array(bytes.buffer);
  const float32 = new Float32Array(pcm16.length);
  for (let i = 0; i < pcm16.length; i++) {
    float32[i] = pcm16[i] / 32768.0;
  }

  const audioBuffer = audioContext.createBuffer(1, float32.length, 24000);
  audioBuffer.copyToChannel(float32, 0);

  const source = audioContext.createBufferSource();
  source.buffer = audioBuffer;
  source.connect(audioContext.destination);

  const currentTime = audioContext.currentTime;

  if (nextStartTime <= currentTime) {
    nextStartTime = currentTime + BUFFER_DELAY;
  }

  source.start(nextStartTime);
  nextStartTime += audioBuffer.duration;
}

// ==========================================
// 13. ZAKOŃCZENIE POŁĄCZENIA
// ==========================================
function endCall() {
  clearTimeout(silenceTimer);
  isConnected = false;
  currentNumber = "";
  nextStartTime = 0;
  updateDisplay();

  if (webSocket) {
    webSocket.onclose = null;
    webSocket.close();
    webSocket = null;
  }
  if (mediaStream) {
    mediaStream.getTracks().forEach(t => t.stop());
    mediaStream = null;
  }
  if (audioProcessor) {
    audioProcessor.disconnect();
    audioProcessor = null;
  }

  const status = document.getElementById("call-status");
  status.innerText = "Połączenie zakończone.";
  status.style.color = "#9ca3af";
  
  document.getElementById("call-btn").style.display = "flex";
  document.getElementById("hangup-btn").style.display = "none";
  releaseWakeLock();
}
