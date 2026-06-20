async function scan() {
  const token = document.getElementById("token").value;

  const res = await fetch(`/api/result/${token}`);
  const data = await res.json();

  const el = document.getElementById("result");

  if (!data.win) {
    el.textContent = "落選";
    return;
  }

  el.textContent = "当選: " + data.prize;
}