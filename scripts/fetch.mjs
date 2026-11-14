      const yr = Number(date.slice(0, 4));
      let hist = await api(`/fixtures?team=${me.id}&season=${yr}&from=${RANGE_FROM}&to=${RANGE_TO}`);
      let mine = summarize(hist, me.id);
      if (mine.results.length < 5 || mine.home4.length < 4 || mine.away4.length < 4) {
        hist = hist.concat(await api(`/fixtures?team=${me.id}&season=${yr - 1}&from=${RANGE_FROM}&to=${RANGE_TO}`));
        mine = summarize(hist, me.id);
          }
