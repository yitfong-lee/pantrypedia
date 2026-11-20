# Vendored: qrcode-generator

qrcode.js and qrcode_UTF8.js are copied verbatim from the npm package
qrcode-generator (Kazuhiko Arase, MIT licence).

Why copied instead of bundled: the app has no build step - src/ is shipped
as-is - so a classic <script> tag is all we need. qrcode_UTF8.js is loaded
second and patches the encoder so non-ASCII characters (the checkbox glyphs)
survive.
