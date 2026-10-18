FROM quay.io/prometheus/prometheus:v2.54.1
COPY prometheus.aws.yml /etc/prometheus/prometheus.yml
CMD ["--config.file=/etc/prometheus/prometheus.yml", "--storage.tsdb.path=/prometheus", "--storage.tsdb.retention.time=3d", "--web.enable-lifecycle"]
