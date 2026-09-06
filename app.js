let currentNumber = "";
let isConnected = false;
let webSocket = null;
let audioContext = null;
let mediaStream = null;
let audioProcessor = null;
let wakeLock = null;
let silenceTimer = null;
const SILENCE_TIMEOUT_MS = 6000; // 6 sekund ciszy do pierwszej reakcji

// 1. Weryfikacja hasła stacji
function checkAuth() {
  const entered = document.getElementById("pass-input").value;
  if (entered === CONFIG.STATION_PASSWORD) {
    sessionStorage.setItem("station_auth", "true");
    showPhone();
  } else {
    document.getElementById("auth-error").style.display = "block";
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

// 2. Obsługa klawiatury numerycznej
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
  clearTimeout(silenceTimer); // Zwalnia timer ciszy przy błędzie
  releaseWakeLock(); // Zwalnia blokadę przy błędzie
  const status = document.getElementById("call-status");
  status.innerText = msg;
  status.style.color = "#f87171";
  document.getElementById("call-btn").style.display = "flex";
  document.getElementById("hangup-btn").style.display = "none";
  isConnected = false;
}

function resetSilenceTimer() {
  clearTimeout(silenceTimer);
  if (!isConnected) return;

  // Obliczamy ile milisekund będzie jeszcze mówił dyspozytor
  let remainingSpeakingTime = 0;
  if (audioContext && nextStartTime > audioContext.currentTime) {
    remainingSpeakingTime = (nextStartTime - audioContext.currentTime) * 1000;
  }

  // Czas ciszy (6s) zaczyna płynąć dopiero po zakończeniu mowy dyspozytora
  silenceTimer = setTimeout(() => {
    triggerSilencePrompt();
  }, remainingSpeakingTime + SILENCE_TIMEOUT_MS);
}
function triggerSilencePrompt() {
  if (!isConnected || !webSocket || webSocket.readyState !== WebSocket.OPEN) return;

  console.log("Wykryto ciszę – ponaglam dyspozytora.");

  webSocket.send(JSON.stringify({
    clientContent: {
      turns: [
        {
          role: "user",
          parts: [{ text: "Halo? Nic nie mówię, cisza na linii. Zareaguj natychmiast głosem jako dyspozytor medyczny 999: zapytaj halo czy mnie słychać i ponów pytanie!" }]
        }
      ],
      turnComplete: true
    }
  }));
}

// Blokada wygaszania ekranu
async function requestWakeLock() {
  try {
    if ('wakeLock' in navigator) {
      wakeLock = await navigator.wakeLock.request('screen');
      console.log("Ekran zablokowany przed wygaszeniem.");
    }
  } catch (err) {
    console.warn(`Błąd Wake Lock: ${err.name}, ${err.message}`);
  }
}

// Zwolnienie blokady ekranu
function releaseWakeLock() {
  if (wakeLock !== null) {
    wakeLock.release().then(() => {
      wakeLock = null;
      console.log("Blokada wygaszania ekranu zwolniona.");
    });
  }
}
// 3. Pobieranie GPS i wyszukiwanie realnych AED z OpenStreetMap (Wariant B)
function getUserLocation() {
  return new Promise((resolve) => {
    if (!navigator.geolocation) {
      console.warn("Geolokalizacja niedostępna w przeglądarce.");
      resolve(null);
      return;
    }

    navigator.geolocation.getCurrentPosition(
      (pos) => {
        console.log(`Pobrano GPS: lat=${pos.coords.latitude}, lon=${pos.coords.longitude}, dokładność: ${Math.round(pos.coords.accuracy)}m`);
        resolve({ 
          lat: pos.coords.latitude, 
          lon: pos.coords.longitude,
          accuracy: pos.coords.accuracy 
        });
      },
      (err) => {
        console.warn("Błąd GPS:", err.message);
        resolve(null);
      },
      { 
        enableHighAccuracy: true, // Wymusza fizyczny moduł GPS zamiast przybliżenia po IP
        timeout: 8000,            // Daje telefonowi do 8s na złapanie fixa z satelitów
        maximumAge: 0             // Nie korzysta z przestarzałej lokalizacji z pamięci podręcznej
      }
    );
  });
}
// Pomocnicze obliczanie dystansu w metrach
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

// Pomocnicza funkcja: Odwrócone geokodowanie (OSM Nominatim)
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
    return data.display_name?.split(",").slice(0, 2).join(",") || "Adres wg mapy";
  } catch (err) {
    console.warn("Błąd Reverse Geocoding:", err);
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

    // Maksymalny zasięg pieszego biegu po aparat (np. 800 metrów)
    const MAX_DISTANCE = 800;

    // Szybki wstępny filtr współrzędnych (delta ok. 1.2 km)
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

    // Przetwarzamy do 3 najbliższych punktów
    const topCandidates = candidates.slice(0, 3);
    const resolvedPoints = [];

    for (let i = 0; i < topCandidates.length; i++) {
      const item = topCandidates[i];
      const tags = item.el.tags || {};

      // 1. Nazwa obiektu
      const placeName = tags["name"] || tags["operator"] || "Budynek użyteczności publicznej / obiekt komercyjny";

      // 2. Opis umiejscowienia
      const placementDesc = tags["defibrillator:location"] || tags["description"] || "na ścianie / przy wejściu głównym";

      // 3. Adres z tagów OSM lub z Reverse Geocoding
      let address = "";
      if (tags["addr:street"]) {
        address = `ul. ${tags["addr:street"]} ${tags["addr:housenumber"] || ""}`.trim();
        if (tags["addr:city"]) address += `, ${tags["addr:city"]}`;
      } else {
        // Jeśli nie ma adresu w tagach, dociągamy go przez Reverse Geocoding
        const fetchedAddress = await reverseGeocode(item.lat, item.lon);
        address = fetchedAddress ? fetchedAddress : "współrzędne obiektu w terenie";
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
      `PUNKT ${p.num}${p.num === 1 ? ' (Najbliższy)' : ''}: Odległość: ok. ${p.distance} m | Adres: ${p.address} | Nazwa obiektu: ${p.placeName} | Dokładne umiejscowienie aparatu: ${p.placementDesc}`
    ).join("\n");

    return `ZAREJESTROWANE APARATY AED W OKOLICY:\n${formattedList}`;

  } catch (e) {
    console.error("Błąd bazy AED:", e);
    status.innerText = "Błąd bazy lokalnej!";
    return "Nie udało się ustalić bazy AED. Wskaż typowy punkt zastępczy.";
  }
}

// 4. Dynamiczne wykrycie obsługiwanego modelu Live API
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
      const preferred = bidiModels.find(m => m.includes("flash")) || bidiModels[0];
      return preferred;
    } else {
      showError("Twój klucz nie ma włączonej obsługi dwukierunkowego Live API.");
      return null;
    }
  } catch (err) {
    showError("Błąd sieci podczas sprawdzania modeli: " + err.message);
    return null;
  }
}

// Pomocnicza funkcja do opóźnień
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Odtwarzanie zapowiedzi IVR (2 do 3 powtórzeń z przerwą 1s)
async function playWaitMessageSequence() {
  const status = document.getElementById("call-status");
  const repeatCount = Math.floor(Math.random() * (3 - 2 + 1)) + 2;

  for (let i = 0; i < repeatCount; i++) {
    if (!isConnected) break;

    status.innerText = `Łączenie... (${i + 1}/${repeatCount})`;
    status.style.color = "#fbbf24";

    await new Promise((resolve) => {
      const waitAudio = new Audio("czekaj.mp3");
      waitAudio.onended = resolve;
      waitAudio.onerror = () => {
        console.warn("Brak pliku czekaj.mp3, pomijam zapowiedź.");
        resolve();
      };
      waitAudio.play().catch(() => resolve());
    });

    if (i < repeatCount - 1 && isConnected) {
      await sleep(1000);
    }
  }
}

// 5. Rozpoczęcie połączenia
async function startCall() {
  if (currentNumber !== "999" && currentNumber !== "112") {
    showError("Niepoprawny numer. Wybierz 999 lub 112.");
    return;
  }

  document.getElementById("call-btn").style.display = "none";
  document.getElementById("hangup-btn").style.display = "flex";
  isConnected = true;
await requestWakeLock(); // Utrzymuje włączony ekran
  
  // 1. Uruchamiamy odtwarzanie zapowiedzi czekaj.mp3
  const ivrPromise = playWaitMessageSequence();

  // 2. W tle równolegle pobieramy GPS, bazę AED i model
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

  // Czekamy aż skończą się komunikaty audio ORAZ przygotują dane
  const [_, setupData] = await Promise.all([ivrPromise, setupPromise]);

  if (!isConnected) return;

  if (!setupData || !setupData.detectedModel) {
    showError("Nie udało się połączyć z modelem dyspozytora.");
    return;
  }

  await initLiveConnection(setupData.systemPrompt, setupData.detectedModel);
}

// 6. Połączenie WebSocket z Gemini Live
async function initLiveConnection(instructions, modelName) {
  const status = document.getElementById("call-status");
  status.innerText = `Łączenie z dyspozytorem...`;
  status.style.color = "#fbbf24";

  try {
    audioContext = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 24000 });
    if (audioContext.state === 'suspended') {
      await audioContext.resume();
    }
  } catch (e) {
    showError("Błąd AudioContext: " + e.message);
    return;
  }

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

  const uri = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContent?key=${CONFIG.GEMINI_API_KEY}`;
  webSocket = new WebSocket(uri);

 webSocket.onopen = () => {
    status.innerText = "Połączenie odebrane. Dyspozytor zgłasza się...";
    status.style.color = "#4ade80";
resetSilenceTimer();
   
   // Definicja profili dyspozytorów z pewnymi głosami
    const dispatchers = [
      { 
        voice: "Kore", // Wyrazisty, pewny głos kobiecy
        intro: "Odbierasz połączenie 999. Jesteś kobietą — dyspozytorką medyczną. Zgłoś się natychmiast regulaminowym powitaniem dyspozytora i zapytaj o adres zdarzenia." 
      },
      { 
        voice: "Fenrir", // Spokojny, niski głos męski
        intro: "Odbierasz połączenie 999. Jesteś mężczyzną — dyspozytorem medycznym. Zgłoś się natychmiast regulaminowym powitaniem dyspozytora i zapytaj o adres zdarzenia." 
      }
    ];

    const currentDispatcher = dispatchers[Math.floor(Math.random() * dispatchers.length)];
    console.log("Wylosowano dyspozytora:", currentDispatcher.voice);

    const setupMessage = {
      setup: {
        model: modelName,
        generationConfig: {
          responseModalities: ["AUDIO"],
          speechConfig: {
            voiceConfig: {
              prebuiltVoiceConfig: { voiceName: currentDispatcher.voice }
            }
          }
        },
        systemInstruction: {
          parts: [{ text: instructions }]
        }
      }
    };

    webSocket.send(JSON.stringify(setupMessage));

    // Wymuszenie odezwania się z uwzględnieniem płci w powitaniu
    webSocket.send(JSON.stringify({
      clientContent: {
        turns: [
          {
            role: "user",
            parts: [{ text: currentDispatcher.intro }]
          }
        ],
        turnComplete: true
      }
    }));

    startAudioStreaming();
  };

webSocket.onmessage = async (event) => {
    try {
      let data;
      if (event.data instanceof Blob) {
        data = JSON.parse(await event.data.text());
      } else {
        data = JSON.parse(event.data);
      }

      if (data.serverContent?.modelTurn?.parts) {
        for (const part of data.serverContent.modelTurn.parts) {
          if (part.inlineData?.data) {
            playAudioChunk(part.inlineData.data);
          }
        }
        // Uruchamiamy odliczanie dopiero po załadowaniu całej odebranej frazy do odtworzenia
        resetSilenceTimer();
      }
    } catch (err) {
      console.error("Błąd parsowania:", err);
    }
  };

  webSocket.onerror = (err) => {
    console.error("WebSocket error:", err);
    showError("Błąd gniazda WebSocket.");
  };

  webSocket.onclose = (event) => {
    if (isConnected) {
      showError(`Rozłączono (Kod: ${event.code}, ${event.reason || 'Brak szczegółów'})`);
    }
  };
}

// 7. Przesyłanie strumienia głosu z mikrofonu
function startAudioStreaming() {
  const inputAudioCtx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 16000 });
  const source = inputAudioCtx.createMediaStreamSource(mediaStream);
  
  audioProcessor = inputAudioCtx.createScriptProcessor(4096, 1, 1);
  source.connect(audioProcessor);
  audioProcessor.connect(inputAudioCtx.destination);

  audioProcessor.onaudioprocess = (e) => {
    if (!isConnected || !webSocket || webSocket.readyState !== WebSocket.OPEN) return;
    
    const inputData = e.inputBuffer.getChannelData(0);
    // Sprawdzenie czy użytkownik mówi (przekroczenie progu szumu)
  let sum = 0;
  for (let i = 0; i < inputData.length; i++) sum += inputData[i] * inputData[i];
  const rms = Math.sqrt(sum / inputData.length);
  if (rms > 0.05) {
    // Kursant mówi – resetujemy licznik ciszy
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

// 8. Odtwarzanie głosu dyspozytora
let nextStartTime = 0;
const BUFFER_DELAY = 0.25; // Zwiększony bufor zapobiegający gubieniu początków słów

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

  // Jeśli bufor się opróżnił, dajemy margines 250ms na stabilne zbuforowanie pakietów
  if (nextStartTime <= currentTime) {
    nextStartTime = currentTime + BUFFER_DELAY;
  }

  source.start(nextStartTime);
  nextStartTime += audioBuffer.duration;
}

// 9. Zakończenie połączenia
function endCall() {
  clearTimeout(silenceTimer);
  isConnected = false;
  currentNumber = "";
  updateDisplay();

  if (webSocket) {
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
  releaseWakeLock(); // Pozwala na ponowne wygaszanie ekranu
}
document.addEventListener('visibilitychange', async () => {
  if (document.visibilityState === 'visible' && isConnected) {
    await requestWakeLock();
  }
});
