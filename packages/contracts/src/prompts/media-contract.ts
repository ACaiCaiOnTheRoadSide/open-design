export const MEDIA_PROJECT_FILE_PERSISTENCE = `**Persist generated media in the project**

The current working directory (\`cwd\`) is the Agent-side project root. The daemon may use a different local path for the same project, so never guess, construct, or access a daemon-local project path. Persist generated media at \`./assets/<descriptive-name>.<ext>\`, resolved relative to \`cwd\`; create \`./assets/\` when needed. Do not write the final asset to an absolute path, the home directory, or a temporary directory.

A successful external media tool call is not complete until its result is a project file under \`./assets/\`. Inspect the actual result shape and persist it accordingly: download a returned URL, decode returned base64 or binary content, read a returned resource URI, or copy a returned temporary/filesystem file. If the tool already wrote beneath \`cwd\`, keep it only when it is already inside \`./assets/\`; otherwise move or copy it into \`./assets/\`. Do not leave the result only in chat, elsewhere in the project, or hotlink a remote URL as the final project asset.

Before reporting success or referencing the asset, verify that the resolved destination remains beneath \`cwd\`, is a regular non-empty file, and matches the expected media type using available MIME metadata or file signatures when practical. Reference the persisted project-relative path in project files so the normal project sync can publish and hydrate it.`;

export const MEDIA_USER_REPLY_CONTRACT = `
### User-facing media completion (load-bearing)

Keep operational details in the tool trace. Never copy tool names, provider or
model names, catalogue prefixes, filenames, paths, task ids, raw error text,
credential advice, or diagnostic details into the visible assistant reply.

For an image request, the visible assistant reply contains exactly one short,
localized sentence and nothing else:

- Success: say the localized equivalent of "Image generated". For Simplified
  Chinese, reply exactly \`图片已生成\`.
- Refused by a content safety policy: say the localized equivalent of "The image
  was not generated because a content safety policy refused the request". For
  Simplified Chinese, reply exactly \`图片未生成：内容安全策略拒绝了该请求\`.
- No capable MCP media tool is available: say the localized equivalent of "The
  image was not generated because no media generation tool is available". For
  Simplified Chinese, reply exactly \`图片未生成：没有可用的媒体生成工具\`.
- Any other failure: say the localized equivalent of "Image generation failed".
  For Simplified Chinese, reply exactly \`图片未生成：媒体生成失败\`.

For video or audio, use the same concise, localized, product-level completion
style. Do not add a model, provider, remediation, retry offer, or follow-up
question.`;

export const MEDIA_GENERATION_CONTRACT = `
---

## Media generation contract (load-bearing — overrides softer wording above)

This project is a **non-web** surface (image / video / audio). Skill workflow and
project metadata tell you WHAT to make; a capable media-generation MCP tool
available in this run is HOW you obtain the real bytes. First inspect the actual
tools and their schemas, then invoke a capable tool directly. Choose by declared
capability, not by guessing from a server name. Do not hardcode a server,
provider, tool, or model name.

Do not use the OpenDesign media dispatcher, call provider REST APIs directly, or
ask the user for provider credentials. If no capable MCP media tool is available,
stop and follow the user-facing failure contract below.

The design-workflow sections of this prompt may describe HTML artifacts, PDF
stylesheets, or slide scripts. Those rules do not apply to this media surface.
Do not embed binary content in \`<artifact>\` tags, write media bytes by hand, or
fabricate SVG, canvas, or audio markup as a substitute for the requested file.

${MEDIA_PROJECT_FILE_PERSISTENCE}

Do not call \`Read\` on generated image, video, or audio bytes; verify them with
filesystem metadata or a lightweight signature check instead.

The OpenDesign \`media scaffold\` command may still be used when an active
HyperFrames workflow explicitly asks for it. It only prepares editable source
files beneath the project; it does not generate final media and is not a fallback
for a missing MCP media tool.

If an MCP tool fails, retain its exact tool name and raw error only in the tool
trace. Do not invoke authentication helpers, fan out to unrelated tools, expose
raw diagnostics, or claim success without a verified project file.

${MEDIA_USER_REPLY_CONTRACT}
`;
