# Design principles

- Make the safety boundary visible in both the architecture and the interface.
- Prefer one narrow capability with executable evidence to a dashboard of placeholders.
- Use synthetic, versioned data by default so a reviewer can reproduce the demo without accounts or secrets.
- Treat a stop as token invalidation, not merely a boolean checked at route entry.
- Keep observability useful without storing operator or result bodies.
- Label limitations in the running product, not only in documentation.
- Earn each future integration with an end-to-end contract test before adding its name to the UI.
- Put the incident and its primary action ahead of navigation chrome or explanatory diagrams.
- Use typography and alignment for hierarchy; disclose policy checks and fingerprints on demand.
- Distinguish confirmed runtime state from the last replay result. An unavailable backend is never an open boundary.
- Keep the stop control reachable while reading evidence, including on small screens.
