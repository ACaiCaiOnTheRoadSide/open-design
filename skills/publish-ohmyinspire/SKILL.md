---
name: publish-ohmyinspire
description: Convert the current OpenDesign project into a valid OhMyInspire template package and publish it to the user's private template library.
arguments:
  - name: workspace
    description: Absolute path of the current project workspace; defaults to the current working directory.
    required: false
---

# Publish OhMyInspire Template

Use this Skill only when the user explicitly asks to publish the current project to OhMyInspire.
The project must be converted into an OhMyInspire template package before uploading. Never upload the raw OpenDesign project archive.

## Required workflow

1. Inspect the current project and identify the runnable HTML entry point, reusable assets, project name, description, and the design guidance in `DESIGN.md` or other project documentation.
2. Create a temporary package directory outside the project. Do not modify or delete the user's project files.
3. Create the package with this structure:
   - `template.json` at the archive root;
   - `SKILL.md` at the archive root, containing concise frontmatter and reusable instructions for using the template;
   - the HTML entry point and only the assets required by that entry point;
   - an optional `preview.html` only when it is the actual preview entry file.
4. Set `template.json` fields consistently:
   - `id`: a stable `od-<project-id>` identifier;
   - `title` and `name`: derived from the project;
   - `description`, `prompt`, `examplePrompt`, `tags`, and `source`;
   - `preview`: `{ "type": "html", "path": "<relative html entry>" }`;
   - `skillPath`: `SKILL.md`.
   Paths must be relative, use POSIX separators, and stay inside the package.
5. Validate before upload:
   - `template.json` and `SKILL.md` exist at the archive root;
   - the preview path exists and points to an HTML file;
   - every referenced asset exists;
   - no absolute paths, secrets, `.env` files, credentials, `.git`, or build caches are included;
   - the resulting ZIP is within the service upload limit.
6. Upload the validated ZIP as multipart form data to:

   `POST "$OD_DAEMON_URL/api/tools/ohmyinspire/templates"`

   Send the generated `template.json` metadata as the `metadata` form field and the ZIP as the `template` form field. Include `Authorization: Bearer $OD_TOOL_TOKEN` and `x-project-id: $OD_PROJECT_ID`. Use a fresh idempotency key for each publish attempt. This Daemon endpoint restores the authenticated project principal and forwards the upload to the backend; never call the backend directly from the sandbox. Do not claim success unless the request returns a successful response.
7. Report the actual server response. If the server returns a template ID or URL, show it; otherwise say that it was saved to the user's OhMyInspire drafts/templates and do not invent a link.

## Safety and failure handling

- Never upload the raw project ZIP.
- Never expose API tokens in chat, files, logs, or the generated package.
- If the project does not contain a usable HTML entry point, stop and explain what is missing.
- If packaging or validation fails, stop before the upload and report the exact validation error.
- Do not use `od publish` or `publish-website`; those publish to a different destination.
