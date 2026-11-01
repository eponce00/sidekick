// Pages for the browser controls benchmark: how actions settle on pages that never sit still or
// load slowly, and a booking form built from the custom pickers and date fields real sites use.

const STYLE = `<style>
  body{font:18px system-ui,sans-serif;padding:24px;max-width:760px}
  label,.field{display:block;margin:14px 0}
  button,input,select{font:18px system-ui,sans-serif}
  .list,.menu,.suggest{border:1px solid #888;background:#fff;max-height:220px;overflow:auto;margin:4px 0;padding:0}
  .list li,.menu div,.suggest div{padding:6px 10px;cursor:pointer;list-style:none}
  .list li:hover,.menu div:hover,.suggest div:hover{background:#def}
  .chip{display:inline-block;background:#e4ecf7;border-radius:12px;padding:2px 10px;margin:2px}
  .spinner{width:28px;height:28px;border:4px solid #ccc;border-top-color:#36c;border-radius:50%;animation:spin .8s linear infinite}
  @keyframes spin{to{transform:rotate(360deg)}}
  dialog table{border-collapse:collapse}dialog td{padding:6px 12px;border-bottom:1px solid #ddd;cursor:pointer}
  dialog tr.active td{background:#def}
</style>`

/** A page whose result appears after `ms` of the click, while the rest of the page does `noise`. */
export function settlePage(scenario: string): string {
  const noise =
    {
      // A carousel, a clock and an analytics beacon: the page never stops changing.
      busy: `<div id="carousel">Slide 1</div><div id="clock"></div>
      <script>let s=1;setInterval(()=>{carousel.textContent='Slide '+(s=s%5+1)},250);
      setInterval(()=>{clock.textContent=new Date().toISOString()},1000);
      setInterval(()=>{new Image().src='/beacon?t='+Date.now()},1500)</script>`,
      // A connection held open in the background, re-opened as soon as it closes.
      longpoll: `<script>(function poll(){fetch('/api/longpoll').then(()=>poll(),()=>setTimeout(poll,500))})()</script>`
    }[scenario] ?? ''
  const action = {
    // The answer takes 2.5 s to arrive.
    'slow-request': `await fetch('/api/slow?ms=2500');render()`,
    busy: `await fetch('/api/slow?ms=400');render()`,
    // Work in the page with a spinner showing and nothing sent or changed until it is done.
    spinner: `notice.innerHTML='<div class="spinner" role="progressbar" aria-label="Loading"></div>';notice.setAttribute('aria-busy','true');
      await new Promise(r=>setTimeout(r,1800));notice.removeAttribute('aria-busy');render()`,
    longpoll: `await fetch('/api/slow?ms=300');render()`,
    instant: `render()`
  }[scenario]
  return `<!doctype html><title>Settle: ${scenario}</title>${STYLE}
    <h1>Settle fixture: ${scenario}</h1>${noise}
    <button id="load">Load results</button><div id="notice"></div><ul id="results"></ul>
    <script>
      function render(){notice.textContent='';results.innerHTML='<li>Result A</li><li>Result B</li>';document.body.dataset.ready='yes'}
      load.addEventListener('click',async()=>{${action}})
    </script>`
}

export const SETTLE_SCENARIOS = ['instant', 'slow-request', 'busy', 'spinner', 'longpoll'] as const

const CITIES = ['Toronto', 'Toronto Island', 'Tokyo', 'Montreal', 'Vancouver', 'Ottawa']
export function cityMatches(query: string): string[] {
  const q = query.trim().toLowerCase()
  return q ? CITIES.filter((city) => city.toLowerCase().includes(q)) : []
}

/**
 * The booking form. Every picker is a different custom widget, and every date field a different
 * kind of control; a hidden summary is what the benchmark reads back.
 */
export function bookingPage(): string {
  return `<!doctype html><title>Booking</title>${STYLE}
  <h1>Synthetic booking — test data only</h1>
  <form id="booking" onsubmit="return false">

  <div class="field"><span id="country-label">Country</span>
    <div><input id="country" role="combobox" aria-labelledby="country-label" aria-expanded="false"
      aria-controls="country-list" aria-autocomplete="list" autocomplete="off" placeholder="Search countries"></div>
    <ul id="country-list" role="listbox" class="list" hidden></ul>
  </div>

  <label>City <input id="city" autocomplete="off" placeholder="Start typing a city"></label>
  <div id="city-suggest" class="suggest" hidden></div>

  <div class="field">Room type
    <button type="button" id="room" aria-label="Room type">Choose a room</button>
    <div id="room-menu" class="menu" hidden>
      <div data-value="std">Standard Queen</div><div data-value="dlx">Deluxe King</div>
      <div data-value="dlx-view">Deluxe King, ocean view</div><div data-value="ste">Suite</div>
    </div>
  </div>

  <div class="field">Amenities <span id="chips"></span>
    <input id="amenities" role="combobox" aria-label="Amenities" aria-controls="amenity-list"
      aria-expanded="false" autocomplete="off" placeholder="Add amenities">
    <ul id="amenity-list" role="listbox" aria-multiselectable="true" class="list" hidden></ul>
  </div>

  <div class="field">Airline
    <button type="button" id="airline" aria-haspopup="dialog">Pick an airline</button>
  </div>
  <dialog id="airline-dialog"><h2>Choose airline</h2>
    <input id="airline-search" type="search" aria-label="Search airlines">
    <table><tbody id="airline-rows"></tbody></table>
    <button type="button" id="airline-ok">Select</button> <button type="button" id="airline-cancel">Cancel</button>
  </dialog>

  <label>Check-in <input id="checkin" type="date"></label>
  <label>Check-out <input id="checkout" inputmode="numeric" placeholder="MM/DD/YYYY" maxlength="10"></label>

  <button id="submit" type="button">Submit booking</button>
  <p id="done" hidden>Booking received.</p>
  </form>
  <script>
  const state={country:'',city:'',room:'',amenities:[],airline:''};
  document.body.dataset.state=JSON.stringify(state);
  const save=()=>{document.body.dataset.state=JSON.stringify(state)};

  // Country: an ARIA combobox that filters as you type.
  const COUNTRIES=['Canada','Cameroon','Cambodia','United States','United Kingdom','Mexico','France'];
  const countryList=document.getElementById('country-list');
  function showCountries(){const q=country.value.toLowerCase();
    countryList.innerHTML=COUNTRIES.filter(c=>c.toLowerCase().includes(q)).map((c,i)=>'<li role="option" id="c'+i+'">'+c+'</li>').join('');
    countryList.hidden=false;country.setAttribute('aria-expanded','true')}
  country.addEventListener('focus',showCountries);country.addEventListener('input',showCountries);
  countryList.addEventListener('mousedown',e=>{const li=e.target.closest('li');if(!li)return;e.preventDefault();
    state.country=li.textContent;country.value=li.textContent;countryList.hidden=true;country.setAttribute('aria-expanded','false');save()});
  country.addEventListener('blur',()=>setTimeout(()=>{countryList.hidden=true},150));

  // City: a typeahead whose suggestions come from the server after a pause, with no ARIA at all.
  const suggest=document.getElementById('city-suggest');let timer;
  city.addEventListener('input',()=>{clearTimeout(timer);state.city='';save();timer=setTimeout(async()=>{
    const r=await fetch('/api/cities?q='+encodeURIComponent(city.value));const list=await r.json();
    suggest.innerHTML=list.map(c=>'<div>'+c+'</div>').join('');suggest.hidden=!list.length},300)});
  suggest.addEventListener('click',e=>{const d=e.target.closest('div');if(!d||d===suggest)return;
    state.city=d.textContent;city.value=d.textContent;suggest.hidden=true;save()});

  // Room: a button that opens a menu of plain divs.
  const menu=document.getElementById('room-menu');
  room.addEventListener('click',()=>{menu.hidden=!menu.hidden});
  menu.addEventListener('click',e=>{const d=e.target.closest('[data-value]');if(!d)return;
    state.room=d.dataset.value;room.textContent=d.textContent;menu.hidden=true;save()});

  // Amenities: a multi-select that adds chips.
  const AMENITIES=['Breakfast','Parking','Late checkout','Airport shuttle','Spa access'];
  const amenityList=document.getElementById('amenity-list');
  function showAmenities(){const q=amenities.value.toLowerCase();
    amenityList.innerHTML=AMENITIES.filter(a=>!state.amenities.includes(a)&&a.toLowerCase().includes(q)).map(a=>'<li role="option">'+a+'</li>').join('');
    amenityList.hidden=false;amenities.setAttribute('aria-expanded','true')}
  function drawChips(){chips.innerHTML=state.amenities.map(a=>'<span class="chip">'+a+' <button type="button" aria-label="Remove '+a+'" data-remove="'+a+'">×</button></span>').join('')}
  amenities.addEventListener('focus',showAmenities);amenities.addEventListener('input',showAmenities);
  amenityList.addEventListener('mousedown',e=>{const li=e.target.closest('li');if(!li)return;e.preventDefault();
    state.amenities.push(li.textContent);amenities.value='';drawChips();showAmenities();save()});
  chips.addEventListener('click',e=>{const a=e.target.dataset.remove;if(!a)return;state.amenities=state.amenities.filter(x=>x!==a);drawChips();save()});
  amenities.addEventListener('blur',()=>setTimeout(()=>{amenityList.hidden=true;amenities.setAttribute('aria-expanded','false')},150));

  // Airline: a dialog with a search box and a results table, confirmed with Select.
  const AIRLINES=[['AC','Air Canada'],['AF','Air France'],['AA','American Airlines'],['WS','WestJet']];
  const dialog=document.getElementById('airline-dialog');let chosen='';
  function drawAirlines(){const q=document.getElementById('airline-search').value.toLowerCase();
    document.getElementById('airline-rows').innerHTML=AIRLINES.filter(([c,n])=>n.toLowerCase().includes(q)||c.toLowerCase()===q)
      .map(([c,n])=>'<tr data-code="'+c+'"'+(c===chosen?' class="active"':'')+'><td>'+c+'</td><td>'+n+'</td></tr>').join('')}
  airline.addEventListener('click',()=>{chosen='';drawAirlines();dialog.showModal()});
  document.getElementById('airline-search').addEventListener('input',drawAirlines);
  document.getElementById('airline-rows').addEventListener('click',e=>{const tr=e.target.closest('tr');if(!tr)return;chosen=tr.dataset.code;drawAirlines()});
  document.getElementById('airline-ok').addEventListener('click',()=>{if(!chosen)return;const name=AIRLINES.find(a=>a[0]===chosen)[1];
    state.airline=chosen;airline.textContent=name;dialog.close();save()});
  document.getElementById('airline-cancel').addEventListener('click',()=>dialog.close());

  // Check-out: a mask that keeps the digits and writes the slashes itself.
  checkout.addEventListener('input',()=>{const d=checkout.value.replace(/\\D/g,'').slice(0,8);
    checkout.value=d.length>4?d.slice(0,2)+'/'+d.slice(2,4)+'/'+d.slice(4):d.length>2?d.slice(0,2)+'/'+d.slice(2):d});

  submit.addEventListener('click',()=>{document.getElementById('done').hidden=false;
    document.body.dataset.submitted=JSON.stringify({...state,checkin:checkin.value,checkout:checkout.value})});
  </script>`
}

/** What a correct booking leaves behind, for the task the benchmark and the model are given. */
export const BOOKING_EXPECTED = {
  country: 'Canada',
  city: 'Toronto',
  room: 'dlx',
  amenities: ['Breakfast', 'Parking'],
  airline: 'AC',
  checkin: '2026-11-14',
  checkout: '11/16/2026'
}

export const BOOKING_TASK =
  'Fill the booking form: Country Canada, City Toronto, Room type Deluxe King (not the ocean view one), amenities Breakfast and Parking, airline Air Canada, check-in 14 November 2026 and check-out 16 November 2026. Then press Submit booking and confirm it says Booking received.'
