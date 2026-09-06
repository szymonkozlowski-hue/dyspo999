async function checkAvailableModels() {
  const status = document.getElementById("call-status");
  status.innerText = "Sprawdzam obsługiwane modele...";
  status.style.color = "#fbbf24";

  try {
    const res = await fetch(`https://generativelanguage.googleapis.com/v1alpha/models?key=${CONFIG.GEMINI_API_KEY}`);
    const data = await res.json();

    if (data.error) {
      showError("Błąd klucza API: " + data.error.message);
      return;
    }

    // Filtrujemy modele wspierające bidiGenerateContent (połączenie na żywo)
    const bidiModels = data.models
      .filter(m => m.supportedGenerationMethods && m.supportedGenerationMethods.includes("bidiGenerateContent"))
      .map(m => m.name);

    if (bidiModels.length > 0) {
      status.innerText = "Dostępny model: " + bidiModels[0];
      status.style.color = "#4ade80";
      console.log("Obsługiwane modele Bidi:", bidiModels);
      return bidiModels[0];
    } else {
      showError("Twój klucz nie ma jeszcze dostępu do modeli Live (BidiGenerateContent).");
      console.log("Wszystkie modele dla klucza:", data.models.map(m => m.name));
      return null;
    }
  } catch (err) {
    showError("Błąd sieci przy pobieraniu modeli: " + err.message);
    return null;
  }
}


let currentNumber = "";
let isConnected = false;
let webSocket = null;
let audioContext = null;
let mediaStream = null;
let audioProcessor = null;

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

async function startCall() {
  if (currentNumber !== "999" && currentNumber !== "112") {
    showError("Niepoprawny numer. Wybierz 999 lub 112.");
    return;
  }

  // Weryfikacja czy wklejono poprawny klucz API
  if (!CONFIG.GEMINI_API_KEY || CONFIG.GEMINI_API_KEY.includes("TUTAJ_WKLEJ")) {
    showError("BŁĄD: W pliku config.js brakuje Twojego klucza Gemini API!");
    return;
  }

  const status = document.getElementById("call-status");
  status.innerText = "Łączenie z 999...";
  status.style.color = "#fbbf24";
  document.getElementById("call-btn").style.display = "none";
  document.getElementById("hangup-btn").style.display = "flex";
  isConnected = true;

  try {
    const rulesRes = await fetch("procedury.txt");
    const systemPrompt = await rulesRes.text();
    await initLiveConnection(systemPrompt);
  } catch (err) {
    showError("Błąd inicjalizacji: " + err.message);
  }
}

async function initLiveConnection(instructions) {
  const status = document.getElementById("call-status");

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
    showError("Brak uprawnień do mikrofonu!");
    return;
  }

  // Oficjalny endpoint Gemini Bidi WebSocket
  const uri = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContent?key=${CONFIG.GEMINI_API_KEY}`;

  webSocket = new WebSocket(uri);

  webSocket.onopen = () => {
    status.innerText = "Połączono. Dyspozytor Medyczny słucha...";
    status.style.color = "#4ade80";

    // Standardowa konfiguracja sesji
    const setupMessage = {
      setup: {
        model: "models/gemini-2.0-flash",
        generationConfig: {
          responseModalities: ["AUDIO"],
          speechConfig: {
            voiceConfig: {
              prebuiltVoiceConfig: {
                voiceName: "Puck"
              }
            }
          }
        },
        systemInstruction: {
          parts: [
            {
              text: instructions
            }
          ]
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
    showError("Błąd połączenia WebSocket.");
  };

  webSocket.onclose = (event) => {
    if (isConnected) {
      showError(`Rozłączono (Kod: ${event.code}, ${event.reason || 'Brak szczegółów'})`);
    }
  };
}

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

let nextStartTime = 0;
function playAudioChunk(base64Data) {
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
    nextStartTime = currentTime;
  }
  source.start(nextStartTime);
  nextStartTime += audioBuffer.duration;
}

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
