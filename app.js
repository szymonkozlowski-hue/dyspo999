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

  // Inicjalizacja dźwięku
  try {
    audioContext = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 24000 });
    if (audioContext.state === 'suspended') {
      await audioContext.resume();
    }
  } catch (e) {
    showError("Błąd AudioContext: " + e.message);
    return;
  }

  // Sprawdzenie mikrofonu przed połączeniem
  try {
    mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (e) {
    showError("Brak dostępu do mikrofonu. Zezwól w przeglądarce!");
    return;
  }

  const host = "generativelanguage.googleapis.com";
  const uri = `wss://${host}/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContent?key=${CONFIG.GEMINI_API_KEY}`;

  webSocket = new WebSocket(uri);

  webSocket.onopen = () => {
    status.innerText = "Połączono. Dyspozytor Medyczny słucha...";
    status.style.color = "#4ade80";

    const setupMessage = {
      setup: {
        model: "models/gemini-2.0-flash-exp",
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
      console.error("Błąd przetwarzania wiadomości:", err);
    }
  };

  webSocket.onerror = (err) => {
    showError("Błąd sieci WebSocket Gemini.");
  };

  webSocket.onclose = (event) => {
    if (isConnected) {
      showError(`Rozłączono przez serwer (Kod: ${event.code}, Powód: ${event.reason || 'brak'})`);
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
