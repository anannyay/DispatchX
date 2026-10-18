FROM grafana/grafana:11.2.0
ENV AWS_REGION=ap-south-1 \
    GF_DASHBOARDS_DEFAULT_HOME_DASHBOARD_PATH=/var/lib/grafana/dashboards/dispatchx.json
COPY provisioning /etc/grafana/provisioning
COPY dashboards /var/lib/grafana/dashboards
