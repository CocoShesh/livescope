# LiveScope v1.8

This build keeps the LiveScope home page, monitor grid, All Chat dropdown, per-stream chat filters, local video reconnect, and the existing server-side `.env` loader. It adds a simple setup command so you do not have to manually create `.env` unless you want to edit it yourself.

## First-time setup

```bash
npm install
npm run setup
nano .env
```

Inside `.env`, set your Euler Stream key:

```env
PORT=8787
EULERSTREAM_API_KEY=YOUR_KEY_HERE
```

Save in nano with `Ctrl+O`, press `Enter`, then exit with `Ctrl+X`.

Then start:

```bash
npm run dev
```

Open:

- Home: http://localhost:8787/
- Monitor: http://localhost:8787/monitor

## One-shot command sequence

After extracting the archive:

```bash
cd ~/Downloads/tiktok-cctv/tiktok-cctv-multiview-v1.6
npm install
npm run setup
nano .env
npm run dev
```

`npm run setup` creates `.env` only when it does not already exist; it never overwrites an existing `.env`.

## Security

`.env` is ignored by Git. Do not paste your API key into chat or commit the `.env` file.


## Room exit / new room

The monitor now has an **Exit Room** button. It stops stream/chat runtimes, clears the current room state for this browser, removes the shared-room hash, and returns to the home page. From Home, the user can start a fresh monitoring room with **Add LIVE** or reopen a saved/shared room.

## Vercel deployment

Install the Vercel CLI (`npm i -g vercel@latest`), then from this directory run `vercel` for a preview and `vercel --prod` for production. Add `EULERSTREAM_API_KEY` in Vercel Project Settings → Environment Variables for Production; do not commit `.env`. Vercel supports Express zero-configuration deployments.

### Vercel entrypoint note

The Vercel entrypoint is `server.js`. It explicitly imports Express so Vercel's Express detector can identify the application entrypoint. No `PORT` environment variable is required on Vercel.
