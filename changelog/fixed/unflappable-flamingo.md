Workers no longer abort on startup when Node.js runs with `--abort-on-uncaught-exception`. The Worker now preloads the Workflow bundle for the debugger only when an inspector is active (#1578).
