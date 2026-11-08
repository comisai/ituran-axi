# ituran-axi recipes

Rows are the indented lines of a TOON table, so `grep '^  '` keeps them and
`sort -t,` sorts them. Use `--fields` to choose simple columns first. A pipeline
needs every row: add `--full` (default output stops at about 4,000 characters)
and a `--limit` that covers the total in the summary line. Reports and safety
grades take at most 1,000 rows a page.

**Vehicles not seen for two days**
```sh
ituran-axi where --stale 48h --limit 2000
```

**Vehicles within 5 km of a point, nearest first**
```sh
ituran-axi where --near 32.08,34.78 --within 5
```

**Battery, fuel or charge readings for every vehicle** (each with its own age)
```sh
ituran-axi diagnostics --all --limit 2000 --full | grep '^  ' | grep -i 'voltage'
```

**Vehicles driving now**
```sh
ituran-axi where --all --fields plate,status,speed --limit 2000 --full | grep '^  ' | grep ',driving,'
```

**Vehicles in a saved place now**
```sh
ituran-axi places <name>            # its id
ituran-axi place <id> --vehicles
```

**Vehicles in no saved place now**
```sh
ituran-axi vehicles --fields plate,places,age --limit 2000 --full | grep '^  ' | grep ',null,'
```

**Distance per vehicle yesterday, most first** (columns: date, plate, distance, ...)
```sh
ituran-axi report daily --date <YYYY-MM-DD> --limit 1000 --full | grep '^  ' | sort -t, -k3 -nr | head
```

**Fastest trips in the last day** (columns: plate, max_speed, driver)
```sh
ituran-axi trips --since 24h --fields plate,max_speed,driver --limit 2000 --full | grep '^  ' | sort -t, -k2 -nr | head
```

**Lowest safety grades this week** (columns: plate, driver, safety, fuel)
```sh
ituran-axi safety vehicles --since 7d --limit 1000 --full | grep '^  ' | sort -t, -k3 -n | head
```

**Engine on and off for one vehicle yesterday**
```sh
ituran-axi report engine <plate> --date <YYYY-MM-DD> --limit 200
```

**Which vehicles are idling now**
```sh
ituran-axi events                    # the idling state's id
ituran-axi event <id>
```
