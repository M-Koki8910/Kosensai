let token = null;

async function register() {
  const res = await fetch("/api/register", {
    method: "POST"
  });

  const data = await res.json();
  token = data.token;

  document.getElementById("token").textContent = token;
}

async function checkResult() {
  if (!token) return;

  const res = await fetch(`/api/result/${token}`);
  const data = await res.json();

  const el = document.getElementById("result");

  if (!data.win) {
    el.textContent = "はずれ";
  } else {
    el.textContent = "当選: " + data.prize;
  }
}