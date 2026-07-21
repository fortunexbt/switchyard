# Design principles

- Make the safety boundary visible in both the architecture and the interface.
- Prefer one narrow capability with executable evidence to a dashboard of placeholders.
- Use synthetic, versioned data by default so a reviewer can reproduce the demo without accounts or secrets.
- Treat a stop as token invalidation, not merely a boolean checked at route entry.
- Keep observability useful without storing operator or result bodies.
- Label limitations in the running product, not only in documentation.
- Earn each future integration with an end-to-end contract test before adding its name to the UI.
