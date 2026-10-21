Fixed a race where finishing a Worker could shut down the shared Runtime while another Worker or replay was being prepared, causing replay creation to fail with a native handle type error.
