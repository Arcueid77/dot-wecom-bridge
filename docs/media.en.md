# Attachments and replies

[中文](media.md) · [English](media.en.md)

| Content | Read | Reply |
| --- | --- | --- |
| Text | Plain and mixed text | At most 20,000 characters; complete file above native limits |
| Images | Download/decrypt PNG, JPEG, GIF | PNG, JPEG, GIF |
| Voice | Platform transcript | Existing AMR, at most 2 MiB |
| Files | Download/decrypt original bytes | Original file |
| Video | Type information | Not implemented |

Each attachment is at most 5 MiB. Official download references expire after five minutes; read them promptly or resend the original. Decryption and private download references stay on the backend.

Use `get_wecom_message` and `get_wecom_attachment` for images/files. Incoming voice uses platform text. Protected Linux processing adds bounded PDF/Office excerpts to readable files; original bytes remain available.

One source selects one final text or media answer. Above 6,826 characters or 20,480 UTF-8 bytes, complete text is delivered as `answer.txt`. Media has no extra caption. `reply_wecom_attachment` can return the same source image/file by index.

Media uploads use 512 KiB parts and the original response reference. Only the corresponding acknowledgement completes a send. Disconnection/timeouts preserve an uncertain result without changing recipient or replaying it. Keep the original database/storage key across restarts.
