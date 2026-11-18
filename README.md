# Translator Interview

A compact Google Meet assistant with an English interface, live English transcription, a list of detected questions, and short English answer suggestions. The left column shows the transcript; the right column contains questions and answers. Requires Python 3.10+ and Google Chrome. No additional packages are needed.

The app window stays at 840 × 760 logical pixels, adjusted to the monitor's usable area. Resizing its borders is disabled. If Chrome's own maximize button enlarges it, the window guard restores its fixed size. Text fields cannot be stretched; long sections scroll internally.

## Start

1. Run `run.bat`. The app always opens in Google Chrome at `http://localhost:8765`. If Chrome is missing, it reports an error rather than opening another browser.
2. Open **API & settings**, paste your OpenAI API key, and select **Apply key**. No restart is needed. Your API project needs model access and available credit. Applying a key does not verify access until an API request is made.
3. Optionally select **Remember on this device** before applying it. Windows encrypts the saved key for your account. Otherwise, it remains in server memory until the server closes.
4. Open `https://meet.google.com` in another tab of the same Chrome profile and join the meeting.
5. Select **Listen to Meet**, choose the Meet **tab**, and enable **Share tab audio**. This is separate from presenting your screen inside Meet.
6. English transcript text appears as the Realtime service recognizes speech. Partial text may be revised when the turn is finalized.
7. **Detected questions** keeps a numbered list. Questions containing `?` initially show **Under review**. The context detector confirms them and separates multiple questions from the same turn. It also recognizes follow-ups such as “Why?” and requests such as “Tell me about your experience.” Select a **Confirmed** question, then choose **Generate answer**. Answers are never generated automatically.
8. **Stop** closes audio capture. **Clear** also stops capture, discards pending results, and clears the conversation context and question list.

Use **Add context or a question** to enter English text without capturing audio. New questions are added without replacing your current selection. Transcription continues while an answer is generated. Answers use natural, conversational English, normally one or two sentences of 20–40 words; extra detail is included only when the question asks for it. Suggestions are not posted to Meet or spoken aloud.

## English recognition and accuracy

The Realtime session is configured for English with `languages: ["en"]`, English transcription guidance, and common technical vocabulary. Its `medium` delay setting prioritizes accuracy over the previous minimum-delay setting. Audio is still streamed in 10 ms packets; the app waits for 500 ms of silence before finalizing a turn, which helps avoid cutting words and phrases too early.

Unexpected non-Latin transcript fragments are marked `[unclear]` instead of being silently removed or replaced with guessed English words. This is a fallback, not a guarantee that every recognized word is correct. Clear speech, sufficient volume, and sharing only the intended tab help recognition. The app does not translate other languages into English.

Partial text can take slightly longer to appear with the accuracy setting. End-to-end latency depends on the network, service, audio, and computer; a sub-millisecond transcript cannot be guaranteed. Packet duration is not recognition latency. The first-partial indicator measures from the first detected speech to the first useful text received on that connection.

Conversation context stays in memory. Each analysis and answer request includes up to the latest 100,000 characters. The visible transcript contains the latest 80 turns, without removing older turns from context merely because they are no longer visible. Pending new fragments are analyzed together so a question followed quickly by another sentence is not lost. Results for a partial that has since changed are discarded. Answers use the context available when you click the answer button.

## Restart behavior

Each `run.bat` launch finds the processes listening on the configured `PORT` (8765 by default), stops them, and waits for the port to become free before starting the app. This also stops another application using that port. If Windows denies access or the port remains occupied, startup stops with an error. It does not stop Chrome or other processes by name. Session-only keys are lost on restart; keys remembered in Windows are retained.

## Data and limits

- Capture requires browser permission. Use it with the participants' permission.
- Captured tab audio normally contains remote speakers, not your own microphone. The app does not capture the microphone separately.
- Chrome requires a video track to share a tab, but the app processes and sends only audio. It does not save or send images.
- PCM audio is sent to OpenAI Realtime. Text and conversation context are sent for question detection and, when you click the button, answer generation. Recordings, transcripts, and context are not saved to disk. The provider's data policies still apply. Analysis and answer requests use `store: false`.
- The main API key stays on the local Python server and is not returned to the interface or saved in browser storage. The browser receives a temporary Realtime credential for the audio connection. The server binds to `127.0.0.1` and checks Host and Origin. Do not expose it publicly.
- **Remember on this device** uses Windows DPAPI and stores encrypted data at `%LOCALAPPDATA%\TranslatorInterview\api-key.bin`. Applying a session-only key or choosing **Remove saved key** removes that file. Closing the app window does not close the server; remove a session key in settings or close the server console to end its use.
- Transcription and question detection can make mistakes. Review suggestions. There is no web search or external-document access.
- If the audio connection fails or becomes congested, follow the on-screen message and reconnect. Question detection runs separately so it does not block incoming transcript text.
- Chrome's picker can select other tabs. Verify that you selected Meet; the app cannot force or verify the selected tab's URL.

## Configuration

Configure the key in **API & settings**. `OPENAI_API_KEY` in the environment or `.env` remains supported as a fallback. A key applied in the app takes priority. Removing it returns to the environment or `.env` key, if one exists; the interface then shows **From .env / environment**.

Optional `.env` values (see `.env.example`):

- `OPENAI_API_KEY`
- `REALTIME_TRANSCRIPTION_MODEL` — defaults to `gpt-live-transcribe`
- `ANSWER_MODEL` — defaults to `gpt-4.1-mini`
- `ANALYSIS_MODEL` — defaults to `ANSWER_MODEL`
- `PORT` — defaults to `8765`

The Realtime model must support incremental transcription, English language hints, and the accuracy delay setting. The analysis model must support structured outputs through the Responses API. Restart after editing `.env`. Do not share that file.

If speech is not transcribed, check **Share tab audio** and the level indicator. Lower **Voice threshold** if speech is too quiet to trigger capture. An HTTP 429 error can mean insufficient credit or a request limit. Use Ctrl+C in the server console to close the server.

## Verify

Run `python -m unittest discover -s tests -v`. With Node.js, `node tests/frontend.js` checks context, partials, and manual answers; `node tests/realtime.js` checks connection setup, audio, pauses, and shutdown. These tests use a simulated provider and do not consume API credit. A real audio test needs a valid key with Realtime access and a shared tab containing speech.

References: [tab audio capture](https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getDisplayMedia), [Realtime transcription](https://developers.openai.com/api/docs/guides/realtime-transcription), [WebSocket authentication](https://developers.openai.com/api/docs/guides/voice-websockets), [Responses API](https://developers.openai.com/api/docs/guides/text).
