# Fanmili optional OCR component

This internal-only service contains Tesseract, Simplified Chinese and English
models. The default Fanmili image does not include these large OCR assets.

The service exposes `GET /health` and `POST /recognize` on port 3100. It is
intended to be reachable only from the private Docker Compose network; do not
publish the port to the host or Internet.
