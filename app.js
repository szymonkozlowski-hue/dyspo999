let currentNumber = "";
let isConnected = false;
let webSocket = null;
let audioContext = null;
let mediaStream = null;
let audioProcessor = null;

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
  const status = document.getElementById("call-status");
  status.innerText = msg;
  status.style.color = "#f87171";
  document.getElementById("call-btn").style.display = "flex";
  document.getElementById("hangup-btn").style.display = "none";
  isConnected = false;
}

// 3. Pobieranie GPS i wyszukiwanie realnych AED z OpenStreetMap (Wariant B)
function getUserLocation() {
  return new Promise((resolve) => {
    if (!navigator.geolocation) {
      resolve(null);
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => resolve({ lat: pos.coords.latitude, lon: pos.coords.longitude }),
      (err) => {
        console.warn("Brak dostępu do GPS:", err.message);
        resolve(null);
      },
      { timeout: 4000, maximumAge: 60000 }
    );
  });
}

async function fetchNearbyAEDs(lat, lon) {
  if (!lat || !lon) return "Brak odczytu GPS zgłaszającego. Wskaż typowy punkt w pobliżu.";

  // Szukamy w promieniu 1500m w bazie OpenStreetMap
  const overpassQuery = `[out:json][timeout:5];
    node["emergency"="defibrillator"](around:1500,${lat},${lon});
    out body 5;`;

  try {
    const res = await fetch(`https://overpass-api.de/api/interpreter?data=${encodeURIComponent(overpassQuery)}`);
    const data = await res.json();

    if (!data.elements || data.elements.length === 0) {
      return "W promieniu 1.5 km w rejestrze OpenStreetMap nie ma zarejestrowanych aparatów AED.";
    }

    const aedList = data.elements.map((el, i) => {
      const tags = el.tags || {};
      const desc = tags.description || tags["defibrillator:location"] || tags["operator"] || "Aparat AED";
      const street = tags["addr:street"] ? `przy ul. ${tags["addr:street"]} ${tags["addr:housenumber"] || ""}` : "";
      return `${i + 1}. ${desc} ${street}`.trim();
    }).join("; ");

    return `RZECZYWISTE PUNKTY AED W NAJBLIŻSZEJ OKOLICY ZGŁASZAJĄCEGO (z bazy OpenStreetMap): ${aedList}`;
  } catch (e) {
    console.warn("Błąd pobierania bazy OSM:", e);
    return "Nie udało się połączyć z bazą OpenStreetMap. Wskaż realistyczny punkt zastępczy.";
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

// 5. Rozpoczęcie połączenia
async function startCall() {
  if (currentNumber !== "999" && currentNumber !== "112") {
    showError("Niepoprawny numer. Wybierz 999 lub 112.");
    return;
  }

  document.getElementById("call-btn").style.display = "none";
  document.getElementById("hangup-btn").style.display = "flex";
  isConnected = true;

  const status = document.getElementById("call-status");
  status.innerText = "Ustalanie pozycji i bazy AED...";
  status.style.color = "#fbbf24";

  // Pobranie GPS i zapytanie do OpenStreetMap przed zestawieniem połączenia
  const coords = await getUserLocation();
  let aedContext = "";
  if (coords) {
    aedContext = await fetchNearbyAEDs(coords.lat, coords.lon);
  }

  const detectedModel = await checkAvailableModels();
  if (!detectedModel) return;

  try {
    const rulesRes = await fetch("procedury.txt");
    let systemPrompt = await rulesRes.text();

    // Wstrzyknięcie realnych danych z OpenStreetMap wprost do instrukcji systemowej
    if (aedContext) {
      systemPrompt += `\n\n[DANE SYSTEMOWE DYSPYZYTORA - PUNKTY AED]:\n${aedContext}\nUżyj tych konkretnych punktów, instruując świadka o wysłaniu kogoś po AED.`;
    }

    await initLiveConnection(systemPrompt, detectedModel);
  } catch (err) {
    showError("Błąd inicjalizacji: " + err.message);
  }
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
    status.innerText = "Połączono. Dyspozytor Medyczny słucha...";
    status.style.color = "#4ade80";

    const setupMessage = {
      setup: {
        model: modelName,
        generationConfig: {
          responseModalities: ["AUDIO"],
          speechConfig: {
            voiceConfig: {
              prebuiltVoiceConfig: { voiceName: "Puck" }
            }
          }
        },
        systemInstruction: {
          parts: [{ text: instructions }]
        }
      }
    };

    webSocket.send(JSON.stringify(setupMessage));
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
const BUFFER_DELAY = 0.12;

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

  if (nextStartTime < currentTime) {
    nextStartTime = currentTime + BUFFER_DELAY;
  }

  source.start(nextStartTime);
  nextStartTime += audioBuffer.duration;
}

// 9. Zakończenie połączenia
function endCall() {
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
}
