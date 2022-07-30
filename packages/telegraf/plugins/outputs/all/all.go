package all

import (
	//Blank imports for plugins to register themselves
	_ "github.com/influxdata/telegraf/plugins/outputs/azure_data_explorer"
	_ "github.com/influxdata/telegraf/plugins/outputs/http"
	_ "github.com/influxdata/telegraf/plugins/outputs/influxdb_v2"
	_ "github.com/influxdata/telegraf/plugins/outputs/prometheus_client"
)
