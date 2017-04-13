## install

installs `zenbot` command and core code.

```
git clone https://github.com/carlos8f/zenbot.git
cd zenbot
npm install
npm link
```

## add an exchange

- adds supporting code for a given exchange (example: `gdax`)
- do `zenbot extend` in each exchange code dir you wish to use

```
git clone https://github.com/carlos8f/zenbot_gdax.git
cd zenbot_gdax
npm install
zenbot extend
```

## add selectors to watch

- a watch selector is in the form `<exchange>.<pair>`
- do `watch` command for each selector you wish to record data for

(example: `gdax.BTC-USD`)

```
zenbot watch gdax.BTC-USD
```

## start the watcher daemon

- creates a long-running process to record trade data

```
zenbot watcher start
```

## add selectors to trade

- a trade selector is in the form of `<exchange>.<pair>.<strategy>`
- you can list available strategies with `zenbot list-strategies`
- do `trade` command for each selector you wish to trade
- each traded selector should be watched also

```
zenbot trade gdax.BTC-USD.default
```

## start the trader daemon

- creates a long-running process to perform trades

```
zenbot trader start
```

## monitor status

```
zenbot status
```
