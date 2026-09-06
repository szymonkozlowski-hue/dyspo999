let currentNumber = "";
let isConnected = false;

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

// Zapamiętanie logowania na czas sesji przeglądarki
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

// 3. Rozpoczęcie połączenia
function startCall() {
  if (currentNumber !== "999" && currentNumber !== "112") {
    document.getElementById("call-status").innerText = "Niepoprawny numer. Wybierz 999 lub 112.";
    document.getElementById("call-status").style.color = "#f87171";
    return;
  }

  document.getElementById("call-status").innerText = "Łączenie z Dyspozytornią Medyczną...";
  document.getElementById("call-status").style.color = "#fbbf24";
  document.getElementById("call-btn").style.display = "none";
  document.getElementById("hangup-btn").style.display = "flex";
  isConnected = true;

  // Odczytanie procedur z pliku procedury.txt
  fetch("procedury.txt")
    .then(res => res.text())
    .then(rules => {
      console.log("Załadowano procedury ratownicze (" + rules.length + " znaków).");
      document.getElementById("call-status").innerText = "Połączono. Dyspozytor Medyczny 2137 słucha...";
      document.getElementById("call-status").style.color = "#4ade80";
    })
    .catch(err => {
      console.error("Błąd odczytu pliku procedur:", err);
    });
}

// 4. Zakończenie połączenia
function endCall() {
  isConnected = false;
  currentNumber = "";
  updateDisplay();
  document.getElementById("call-status").innerText = "Połączenie zakończone.";
  document.getElementById("call-status").style.color = "#9ca3af";
  document.getElementById("call-btn").style.display = "flex";
  document.getElementById("hangup-btn").style.display = "none";
}
