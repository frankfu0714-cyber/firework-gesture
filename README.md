# 幫你放煙火 · Wave to Spark Fireworks

A gesture-controlled fireworks web experience. Falling seeds drift down through a Lunar New Year night sky — wave your hand through the webcam feed and they detonate into colorful bursts with synthesized boom + crackle.

## Stack

- Single-page static site — `index.html`, `app.js`, `vercel.json`.
- Canvas 2D for rendering, object-pooled particles (cap 600).
- [MediaPipe Hands](https://github.com/google/mediapipe) (CDN) for hand tracking on desktop.
- Web Audio API for synthesized booms, sub-thuds, crackle, and a metallic ping.

## Controls

- **Desktop**: allow webcam → wave a hand. Mouse works as a fallback before hands lock on.
- **Mobile**: tap anywhere — it detonates the nearest seed (or paints a fresh burst).

## Run locally

```sh
python3 -m http.server 8000
# then open http://localhost:8000
```

`getUserMedia` works on `localhost` without HTTPS. For other hosts you need the Vercel URL.

## Deploy

```sh
vercel deploy --prod
```
