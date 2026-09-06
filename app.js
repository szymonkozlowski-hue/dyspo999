let currentNumber = "";
let isConnected = false;
let webSocket = null;
let audioContext = null;
let mediaStream = null;
let audioProcessor = null;

// 1. Logowanie do stacji
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

// 2. Klawiatura numeryczna
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

// 3. Rozpoczęcie połączenia
async function startCall() {
  if (currentNumber !== "999" && currentNumber !== "112") {
    const status = document.getElementById("call-status");
    status.innerText = "Niepoprawny numer. Wybierz 999 lub 112.";
    status.style.color = "#f87171";
    return;
  }

  const status = document.getElementById("call-status");
  status.innerText = "Łączenie z 999...";
  status.style.color = "#fbbf24";
  document.getElementById("call-btn").style.display = "none";
  document.getElementById("hangup-btn").style.display = "flex";
  isConnected = true;

  try {
    // Pobieramy procedury z pliku procedury.txt
    const rulesRes = await fetch("procedury.txt");
    const systemPrompt = await rulesRes.text();

    await initLiveConnection(systemPrompt);
  } catch (err) {
    console.error("Błąd połączenia:", err);
    status.innerText = "Błąd połączenia. Sprawdź uprawnienia mikrofonu.";
    status.style.color = "#f87171";
    endCall();
  }
}

// 4. Połączenie z Gemini Multimodal Live API
async function initLiveConnection(instructions) {
  const status = document.getElementById("call-status");
  audioContext = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 24000 });

  // Endpoint WebSocket Gemini Live
  const host = "generativelanguage.googleapis.com";
  const uri = `wss://${host}/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContent?key=${CONFIG.GEMINI_API_KEY}`;

  webSocket = new WebSocket(uri);

  webSocket.onopen = async () => {
    status.innerText = "Połączono. Dyspozytor Medyczny 2137 słucha...";
    status.style.color = "#4ade80";

    // Konfiguracja sesji i narzędzi (Tool Calling dla AED)
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
        },
        tools: [
          {
            functionDeclarations: [
              {
                name: "znajdz_aed",
                description: "Szuka najbliższego defibrylatora AED na podstawie adresu.",
                parameters: {
                  type: "OBJECT",
                  properties: {
                    address: {
                      type: "STRING",
                      description: "Pełny adres zdarzenia: ulica, numer, miejscowość oraz województwo"
                    }
                  },
                  required: ["address"]
                }
              }
            ]
          }
        ]
      }
    };

    webSocket.send(JSON.stringify(setupMessage));
    await startMicrophone();
  };

  webSocket.onmessage = async (event) => {
    let data;
    if (event.data instanceof Blob) {
      data = JSON.parse(await event.data.text());
    } else {
      data = JSON.parse(event.data);
    }

    // Obsługa wywołania narzędzia AED
    if (data.toolCall) {
      for (const call of data.toolCall.functionCalls) {
        if (call.name === "znajdz_aed") {
          const result = await lookupAED(call.args.address);
          const responseMsg = {
            toolResponse: {
              functionResponses: [
                {
                  response: { output: result },
                  id: call.id
                }
              ]
            }
          };
          webSocket.send(JSON.stringify(responseMsg));
        }
      }
    }

    // Odtwarzanie dźwięku z Gemini
    if (data.serverContent?.modelTurn?.parts) {
      for (const part of data.serverContent.modelTurn.parts) {
        if (part.inlineData?.data) {
          playAudioChunk(part.inlineData.data);
        }
      }
    }
  };

  webSocket.onerror = (err) => {
    console.error("Błąd WebSocket:", err);
  };

  webSocket.onclose = () => {
    endCall();
  };
}

// 5. Obsługa mikrofonu
async function startMicrophone() {
  mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
  const inputAudioCtx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 16000 });
  const source = inputAudioCtx.createMediaStreamSource(mediaStream);
  
  audioProcessor = inputAudioCtx.createScriptProcessor(4096, 1, 1);
  source.connect(audioProcessor);
  audioProcessor.connect(inputAudioCtx.destination);

  audioProcessor.onaudioprocess = (e) => {
    if (!isConnected || webSocket?.readyState !== WebSocket.OPEN) return;
    const inputData = e.inputBuffer.getChannelData(0);
    const pcm16 = new Int16Array(inputData.length);
    for (let i = 0; i < inputData.length; i++) {
      pcm16[i] = Math.max(-1, Math.min(1, inputData[i])) * 0x7fff;
    }
    
    // Konwersja na Base64
    const buffer = pcm16.buffer;
    let binary = "";
    const bytes = new Uint8Array(buffer);
    for (let i = 0; i < bytes.byteLength; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    const base64Audio = btoa(binary);

    const clientContent = {
      realtimeInput: {
        mediaChunks: [
          {
            mimeType: "audio/pcm;rate=16000",
            data: base64Audio
          }
        ]
      }
    };
    webSocket.send(JSON.stringify(clientContent));
  };
}

// 6. Odpytanie serwera Render o AED
async function lookupAED(address) {
  try {
    const res = await fetch(CONFIG.AED_API_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ address: address })
    });
    return await res.json();
  } catch (err) {
    return { status: "not_found", message: "Brak danych o AED w tym rejonie." };
  }
}

// 7. Odtwarzanie strumienia głosu
let nextStartTime = 0;
function playAudioChunk(base64Data) {
  const binaryString = atob(base64Data);
  const len = binaryString.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
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

// 8. Rozłączenie
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
