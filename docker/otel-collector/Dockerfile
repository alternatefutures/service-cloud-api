FROM otel/opentelemetry-collector-contrib:latest

# Copy custom configuration
COPY otel-collector-config.yaml /etc/otel-collector-config.yaml

# Use the custom config
CMD ["--config=/etc/otel-collector-config.yaml"]
