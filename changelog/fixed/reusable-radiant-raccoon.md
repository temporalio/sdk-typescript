Fix Runtime shutdown closing application-provided loggers. Custom loggers are now flushed without being closed, allowing reuse across Runtime lifecycles.
