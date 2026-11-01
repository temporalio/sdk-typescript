# Changelog fragments

Add a Markdown file under `changelog/<category>/` for each applicable category:

| Folder | Changes |
| --- | --- |
| `added` | New features |
| `stabilized` | Features that are no longer experimental |
| `changed` | Changes to existing behavior |
| `deprecated` | Features scheduled for removal |
| `breaking-changes` | Removed or incompatible behavior |
| `fixed` | Bug fixes |
| `security` | Security fixes |

Use fun, whimsical, unique lowercase kebab-case filenames, such as
`tap-dancing-teapot.md`. The folder supplies the category; the file contains only
the entry text. Keep entries concise, ideally one or two sentences. Write each
entry on one line without a leading list marker (`-`). Each nonempty line becomes
a separate bullet; a fragment may contain multiple entries. Inline Markdown and
links are supported. Do not put headings, nested lists, or code blocks in fragments.

Entries imported by the shared `changelog-tool update-core` command start with
`Core: `. Language-authored entries do not need that prefix. See `CONTRIBUTING.md`
for Core update and release commands.

Release preparation assembles pending fragments into a dated `CHANGELOG.md`
section and consumes them. Completed releases are preserved; there is no
Unreleased section. Fragments merged after preparation remain for the next release.
