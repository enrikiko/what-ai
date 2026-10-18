# OpenWA -> NVIDIA webhook service

Listens on port 80, accepts OpenWA events, logs the complete event, extracts chat/message information, and analyzes the message with an NVIDIA Build model through its OpenAI-compatible API.

## Run
1. Copy `.env.example` to `.env` and set `NVIDIA_API_KEY`.
2. Choose a model from [NVIDIA Build](https://build.nvidia.com/models) in `NVIDIA_MODEL`.
3. Configure OpenWA to POST new-message events to `http://<this-machine-ip>/webhook/openwa`.
4. Start with `npm start`.

OpenWA is configured as `http://192.168.1.245:2785/`. Check with `GET /health`.

Payloads vary between OpenWA versions. The adapter accepts common fields (`chatId`, `from`, `author`, `body`, `text`, `message`, and nested `data`/`message`). Adjust `extractEvent()` after testing a real event if needed.

The generated reply is returned in the webhook response. Sending it back into WhatsApp is left as a separate OpenWA action because the exact send-message endpoint depends on the OpenWA version/configuration.

Structured JSON logs are written to `logs/app.log` and stdout, including request IDs, chat IDs, message IDs, extracted text, model responses, errors, and the full received payload.
# what-ai
