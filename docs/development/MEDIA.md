# README media

The animations in the README are made from recordings of the real app. Nothing in them is drawn
by hand, so they stay true to the app, and they can be made again whenever the app's look changes.

`media/` is a separate package that the app never depends on. It holds three steps:

1. **Capture.** `media/capture` launches the built app in a throwaway `sidekick-e2e-*` profile,
   connected to a scripted model on loopback (`fake-model.mjs`), with a small demo project in a
   folder with no one's name in its path. It types each scene's prompt into the real message box,
   lets the agent work, and records the window from Chromium's screencast at twice its size.
   `scenes.mjs` holds what the model does in each scene; `forecast-artifact.mjs` holds the artifact
   it builds, written in the order the artifact skill asks for, so it takes shape piece by piece.
   The result is `media/public/clips/session.mp4` and the moment each scene starts and ends.
2. **Compose.** `media/src` is a [Remotion](https://www.remotion.dev/) project. Each composition
   frames part of the recording in a floating window with a camera that follows the work, a
   caption, and the app's own colors: `hero` for the top of the README, and one clip per feature.
3. **Render.** `render.mjs` renders each composition and packs it into an animated WebP in
   `docs/assets/media`. WebP keeps the soft backdrop and the app's text clean at a few megabytes
   where a GIF would dither them at many times the size.

## Making them again

From the repository, with the app built:

```bash
npm run build
cd media
npm install
npm run capture
npm run render
npm run screenshots
```

`npm run screenshots` takes the still of Settings → Providers the same way, with local Ollama,
LM Studio and LiteLLM servers stood in for by fake ones; it uses Ollama's and LM Studio's usual
ports, so stop them first if they are running. `npm run studio` opens Remotion's editor to adjust
a composition, and `npm run render -- hero agent` renders only the named ones. Rendering needs Python 3 with Pillow for the WebP packing, and loads
the Inter font from Google Fonts.

The recording, its frames and renders are ignored by Git; only the finished WebP files are
committed. Check them before committing: they are public, so nothing personal, private or
machine-specific may show in them.

## License

Remotion is source-available rather than open source. Its license is free for individuals, small
companies and non-profits; others need a company license to use it. The app does not include or
depend on it.
