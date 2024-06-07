self.addEventListener(
  "message",
  ({ data }) => {
    console.log("[Service Worker] Message", data);
    self.postMessage("pong");
  },
  false,
);

self.addEventListener("install", (e) => {
  console.log("[Service Worker] Install", e);
});
