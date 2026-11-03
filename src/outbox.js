const fs = require("fs");

/*
 * События для ADI, которые ещё не подтверждены: проходы, пока не было
 * интернета, отказы, результаты открытия. Лежат в outbox.jsonl, переживают
 * перезапуск; ADI подтверждает каждое (ack), тогда оно удаляется.
 * Больше MAX — старые выбрасываются: агент не должен забить диск.
 */
const MAX = 10000;

class Outbox {
  constructor(file, log) {
    this.file = file;
    this.log = log;
    this.items = [];
    try {
      this.items = fs
        .readFileSync(file, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l));
    } catch (err) {
      if (err.code !== "ENOENT") log?.warn(`Очередь событий не прочитана: ${err.message}`);
    }
  }

  add(item) {
    this.items.push(item);
    if (this.items.length > MAX) {
      const dropped = this.items.length - MAX;
      this.items = this.items.slice(dropped);
      this.log?.warn(`Очередь событий переполнена — удалено ${dropped} старых`);
      this.rewrite();
      return;
    }
    try {
      fs.appendFileSync(this.file, `${JSON.stringify(item)}\n`);
    } catch (err) {
      this.log?.error(`Очередь событий не записана: ${err.message}`);
    }
  }

  remove(id) {
    const before = this.items.length;
    this.items = this.items.filter((x) => x.id !== id);
    if (this.items.length !== before) this.rewrite();
  }

  rewrite() {
    try {
      const tmp = `${this.file}.tmp`;
      fs.writeFileSync(tmp, this.items.map((x) => `${JSON.stringify(x)}\n`).join(""));
      fs.renameSync(tmp, this.file);
    } catch (err) {
      this.log?.error(`Очередь событий не записана: ${err.message}`);
    }
  }

  all() {
    return [...this.items];
  }
}

module.exports = { Outbox };
