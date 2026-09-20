// The single source of truth for professions, filters and which filters each profession uses.
// Stable keys are identity; labels are data. tools/gen-professions.js turns this into SQL and into
// the browser mock, so the database, the page and the tests never disagree.
// Labels: {en,de,ru,lt,es,pl,uk}. Missing languages fall back to English at runtime; option labels
// that are only English here are filled from professions/tr-<lang>.json by the generator.
const catLabels = require('./cat-labels.json');
const L = (en, more) => Object.assign({ en }, more || {});
const cat = k => catLabels[k];

// ---------- professions ----------
// sort: group block × 100 + position, so a new profession slots in without renumbering the rest
const professions = [
  // ----- video & media -----
  { slug:'video-editor',   group:'video-media',  sort:110, active:true, invite_only:true, units:['hour','project','day'],     portfolio:'video',
    labels:L('Video editor',{de:'Videoeditor',ru:'Видеомонтажёр',lt:'Editorius',es:'Editor de vídeo',pl:'Montażysta wideo',uk:'Відеомонтажер'}),
    synonyms:['editor','video editing','montage','editorius','montažas','монтаж','schnitt','edición','montażysta','video','post production'] },
  { slug:'videographer',   group:'video-media',  sort:120, active:true, invite_only:true, units:['hour','day','project'],     portfolio:'video',
    labels:L('Videographer',{de:'Videograf',ru:'Видеограф',lt:'Videografas',es:'Videógrafo',pl:'Wideograf',uk:'Відеограф'}),
    synonyms:['camera operator','filming','filmavimas','съёмка','filmen','operator','cameraman','shoot','film crew'] },
  { slug:'photographer',   group:'video-media',  sort:130, active:true, invite_only:true, units:['session','hour','day','project'], portfolio:'image',
    labels:L('Photographer',{de:'Fotograf',ru:'Фотограф',lt:'Fotografas',es:'Fotógrafo',pl:'Fotograf',uk:'Фотограф'}),
    synonyms:['photo','photography','fotografas','фото','foto','shoot','fotosesija','zdjęcia'] },
  { slug:'motion-designer',group:'video-media',  sort:140, active:true, invite_only:true, units:['hour','project'],           portfolio:'video',
    labels:L('Motion designer',{de:'Motion Designer',ru:'Моушн-дизайнер',lt:'Judesio dizaineris',es:'Diseñador de motion',pl:'Motion designer',uk:'Моушн-дизайнер'}),
    synonyms:['motion graphics','animation','animator','after effects','grafika','анимация','titles'] },
  { slug:'animator',       group:'video-media',  sort:150, active:true, invite_only:true, units:['project','hour','day'],     portfolio:'video',
    labels:L('Animator',{de:'Animator',ru:'Аниматор',lt:'Animatorius',es:'Animador',pl:'Animator',uk:'Аніматор'}),
    synonyms:['2d animation','3d animation','cartoon','character animation','animacija','анимация','zeichentrick','explainer'] },
  { slug:'colorist',       group:'video-media',  sort:160, active:true, invite_only:true, units:['hour','project','day'],     portfolio:'video',
    labels:L('Colorist',{de:'Colorist',ru:'Колорист',lt:'Koloristas',es:'Colorista',pl:'Kolorysta',uk:'Колорист'}),
    synonyms:['color grading','colour grading','grading','davinci','spalvų korekcija','цветокоррекция','farbkorrektur'] },
  { slug:'drone-operator', group:'video-media',  sort:170, active:true, invite_only:true, units:['hour','day','project'],     portfolio:'video',
    labels:L('Drone operator',{de:'Drohnenpilot',ru:'Оператор дрона',lt:'Dronų operatorius',es:'Piloto de dron',pl:'Operator drona',uk:'Оператор дрона'}),
    synonyms:['drone','aerial','fpv','dronas','дрон','quadcopter','luftaufnahmen','aerial video'] },

  // ----- audio & music -----
  { slug:'sound-designer', group:'audio',        sort:210, active:true, invite_only:true, units:['project','hour'],           portfolio:'link',
    labels:L('Sound designer',{de:'Sounddesigner',ru:'Саунд-дизайнер',lt:'Garso dizaineris',es:'Diseñador de sonido',pl:'Sound designer',uk:'Саунд-дизайнер'}),
    synonyms:['sound design','sfx','foley','game audio','garsas','звук','ton','audio','podcast','muzika','music'] },
  { slug:'audio-editor',   group:'audio',        sort:220, active:true, invite_only:true, units:['hour','project'],           portfolio:'link',
    labels:L('Audio editor',{de:'Audio-Editor',ru:'Аудиомонтажёр',lt:'Garso montuotojas',es:'Editor de audio',pl:'Montażysta dźwięku',uk:'Аудіомонтажер'}),
    synonyms:['podcast editor','audio editing','mixing','mastering','podkastas','подкаст','tonschnitt','audiobook'] },
  { slug:'voice-over',     group:'audio',        sort:230, active:true, invite_only:true, units:['project','hour'],           portfolio:'link',
    labels:L('Voice-over artist',{de:'Sprecher',ru:'Диктор',lt:'Įgarsintojas',es:'Locutor',pl:'Lektor',uk:'Диктор'}),
    synonyms:['voice over','voiceover','narrator','dubbing','įgarsinimas','озвучка','sprecher','narración','dubbing'] },
  { slug:'music-producer', group:'audio',        sort:240, active:true, invite_only:true, units:['project','hour'],           portfolio:'link',
    labels:L('Music producer',{de:'Musikproduzent',ru:'Музыкальный продюсер',lt:'Muzikos prodiuseris',es:'Productor musical',pl:'Producent muzyczny',uk:'Музичний продюсер'}),
    synonyms:['music','composer','beat','score','soundtrack','muzika','музыка','komponist','jingle'] },

  // ----- design & visual -----
  { slug:'graphic-designer',group:'design',      sort:310, active:true, invite_only:true, units:['project','hour'],           portfolio:'image',
    labels:L('Graphic designer',{de:'Grafikdesigner',ru:'Графический дизайнер',lt:'Grafikos dizaineris',es:'Diseñador gráfico',pl:'Grafik',uk:'Графічний дизайнер'}),
    synonyms:['graphic design','designer','grafikas','дизайнер','grafik','poster','flyer','banner','print'] },
  { slug:'brand-designer', group:'design',       sort:320, active:true, invite_only:true, units:['project','hour'],           portfolio:'image',
    labels:L('Brand & logo designer',{de:'Brand- & Logodesigner',ru:'Бренд- и лого-дизайнер',lt:'Prekės ženklo ir logotipų dizaineris',es:'Diseñador de marca y logotipos',pl:'Projektant marki i logo',uk:'Бренд- та лого-дизайнер'}),
    synonyms:['logo','branding','brand identity','rebrand','logotipas','логотип','marke','identidad'] },
  { slug:'ui-ux-designer', group:'design',       sort:330, active:true, invite_only:true, units:['hour','project'],           portfolio:'link',
    labels:L('UI/UX designer',{de:'UI/UX-Designer',ru:'UI/UX-дизайнер',lt:'UI/UX dizaineris',es:'Diseñador UI/UX',pl:'Projektant UI/UX',uk:'UI/UX-дизайнер'}),
    synonyms:['ui','ux','product design','app design','web design','figma','prototype','interface','landing page','svetainės dizainas'] },
  { slug:'illustrator',    group:'design',       sort:340, active:true, invite_only:true, units:['project','hour'],           portfolio:'image',
    labels:L('Illustrator',{de:'Illustrator',ru:'Иллюстратор',lt:'Iliustratorius',es:'Ilustrador',pl:'Ilustrator',uk:'Ілюстратор'}),
    synonyms:['illustration','drawing','character design','comic','iliustracija','иллюстрация','zeichnung','dibujo'] },
  { slug:'three-d-artist', group:'design',       sort:350, active:true, invite_only:true, units:['project','hour'],           portfolio:'image',
    labels:L('3D artist',{de:'3D-Artist',ru:'3D-художник',lt:'3D dailininkas',es:'Artista 3D',pl:'Grafik 3D',uk:'3D-художник'}),
    synonyms:['3d','blender','render','modelling','modeling','vizualizacija','визуализация','cgi','product render'] },
  { slug:'presentation-designer',group:'design', sort:360, active:true, invite_only:true, units:['project','hour'],           portfolio:'link',
    labels:L('Presentation designer',{de:'Präsentationsdesigner',ru:'Дизайнер презентаций',lt:'Prezentacijų dizaineris',es:'Diseñador de presentaciones',pl:'Projektant prezentacji',uk:'Дизайнер презентацій'}),
    synonyms:['pitch deck','slides','powerpoint','keynote','prezentacija','презентация','präsentation','deck'] },
  { slug:'photo-retoucher',group:'design',       sort:370, active:true, invite_only:true, units:['project','hour'],           portfolio:'image',
    labels:L('Photo retoucher',{de:'Bildretuscheur',ru:'Ретушёр',lt:'Nuotraukų retušuotojas',es:'Retocador fotográfico',pl:'Retuszer zdjęć',uk:'Ретушер'}),
    synonyms:['retouching','photo editing','photoshop','background removal','retušas','ретушь','retusche','edición de fotos'] },

  // ----- writing & content -----
  { slug:'copywriter',     group:'writing',      sort:410, active:true, invite_only:true, units:['word','hour','project'],    portfolio:'link',
    labels:L('Copywriter',{de:'Texter',ru:'Копирайтер',lt:'Tekstų kūrėjas',es:'Redactor publicitario',pl:'Copywriter',uk:'Копірайтер'}),
    synonyms:['writer','copy','texts','tekstai','тексты','werbetext','slogan','ad copy'] },
  { slug:'content-writer', group:'writing',      sort:420, active:true, invite_only:true, units:['word','project','hour'],    portfolio:'link',
    labels:L('Content writer',{de:'Content-Writer',ru:'Контент-райтер',lt:'Turinio kūrėjas',es:'Redactor de contenidos',pl:'Content writer',uk:'Контент-райтер'}),
    synonyms:['blog','articles','seo writing','content','straipsniai','статьи','artikel','blogger'] },
  { slug:'scriptwriter',   group:'writing',      sort:430, active:true, invite_only:true, units:['project','hour','word'],    portfolio:'link',
    labels:L('Scriptwriter',{de:'Drehbuchautor',ru:'Сценарист',lt:'Scenaristas',es:'Guionista',pl:'Scenarzysta',uk:'Сценарист'}),
    synonyms:['script','screenplay','scenarijus','сценарий','drehbuch','guion','youtube script','storyboard'] },
  { slug:'translator',     group:'writing',      sort:440, active:true, invite_only:true, units:['word','hour','project'],    portfolio:'link',
    labels:L('Translator',{de:'Übersetzer',ru:'Переводчик',lt:'Vertėjas',es:'Traductor',pl:'Tłumacz',uk:'Перекладач'}),
    synonyms:['translation','localisation','localization','subtitles','vertimas','перевод','übersetzung','tłumaczenie'] },
  { slug:'proofreader',    group:'writing',      sort:450, active:true, invite_only:true, units:['word','hour','project'],    portfolio:'link',
    labels:L('Proofreader & editor',{de:'Lektor & Korrektor',ru:'Корректор и редактор',lt:'Korektorius ir redaktorius',es:'Corrector y editor',pl:'Korektor i redaktor',uk:'Коректор і редактор'}),
    synonyms:['proofreading','editing','korektūra','корректура','lektorat','revisión','copy editing'] },

  // ----- marketing & social media -----
  { slug:'social-media-manager',group:'marketing',sort:510,active:true, invite_only:true, units:['month','project','hour'],   portfolio:'link',
    labels:L('Social media manager',{de:'Social-Media-Manager',ru:'SMM-менеджер',lt:'Socialinių tinklų vadybininkas',es:'Community manager',pl:'Social media manager',uk:'SMM-менеджер'}),
    synonyms:['smm','social media','instagram','tiktok','community','socialiniai tinklai','соцсети','content manager'] },
  { slug:'ads-specialist', group:'marketing',    sort:520, active:true, invite_only:true, units:['month','project','hour'],   portfolio:'link',
    labels:L('Paid ads specialist',{de:'Paid-Ads-Spezialist',ru:'Специалист по рекламе',lt:'Mokamos reklamos specialistas',es:'Especialista en publicidad de pago',pl:'Specjalista od reklam',uk:'Спеціаліст з реклами'}),
    synonyms:['ads','ppc','google ads','meta ads','facebook ads','reklama','реклама','werbung','performance marketing'] },
  { slug:'seo-specialist', group:'marketing',    sort:530, active:true, invite_only:true, units:['month','project','hour'],   portfolio:'link',
    labels:L('SEO specialist',{de:'SEO-Spezialist',ru:'SEO-специалист',lt:'SEO specialistas',es:'Especialista SEO',pl:'Specjalista SEO',uk:'SEO-спеціаліст'}),
    synonyms:['seo','search engine optimisation','optimization','link building','paieškos optimizavimas','продвижение','suchmaschinen'] },
  { slug:'ugc-creator',    group:'marketing',    sort:540, active:true, invite_only:true, units:['project','day'],            portfolio:'video',
    labels:L('UGC creator',{de:'UGC-Creator',ru:'UGC-креатор',lt:'UGC kūrėjas',es:'Creador de UGC',pl:'Twórca UGC',uk:'UGC-креатор'}),
    synonyms:['ugc','user generated content','creator','tiktok creator','reels','influencer','kūrėjas','контент-мейкер'] },

  // ----- development & technology -----
  { slug:'web-developer',  group:'development',  sort:610, active:true, invite_only:true, units:['hour','project'],           portfolio:'link',
    labels:L('Web developer',{de:'Webentwickler',ru:'Веб-разработчик',lt:'Interneto programuotojas',es:'Desarrollador web',pl:'Programista stron',uk:'Веб-розробник'}),
    synonyms:['developer','programmer','programuotojas','разработчик','entwickler','react developer','website','frontend','backend','landing page','online shop','svetainė','сайт'] },
  { slug:'mobile-developer',group:'development', sort:620, active:true, invite_only:true, units:['hour','project'],           portfolio:'link',
    labels:L('Mobile app developer',{de:'App-Entwickler',ru:'Разработчик мобильных приложений',lt:'Mobiliųjų programėlių kūrėjas',es:'Desarrollador de apps móviles',pl:'Programista aplikacji mobilnych',uk:'Розробник мобільних застосунків'}),
    synonyms:['app','ios','android','flutter','react native','programėlė','приложение','app entwickeln'] },
  { slug:'no-code-developer',group:'development',sort:630, active:true, invite_only:true, units:['project','hour'],           portfolio:'link',
    labels:L('No-code website builder',{de:'No-Code-Website-Builder',ru:'No-code разработчик сайтов',lt:'No-code svetainių kūrėjas',es:'Desarrollador no-code',pl:'Twórca stron no-code',uk:'No-code розробник сайтів'}),
    synonyms:['wordpress','webflow','shopify','squarespace','wix','no code','nocode','svetainė','сайт','landing page','online shop'] },
  // not open yet: it shows in the admin panel as closed and nobody can join or ask for it until you open it
  { slug:'game-developer', group:'development',  sort:640, active:false, invite_only:true, units:['hour','project'],           portfolio:'link',
    labels:L('Game developer',{de:'Spieleentwickler',ru:'Разработчик игр',lt:'Žaidimų kūrėjas',es:'Desarrollador de videojuegos',pl:'Programista gier',uk:'Розробник ігор'}),
    synonyms:['game','unity','unreal','godot','žaidimai','игры','spiele','gamedev'] },
];

const groups = {
  'video-media': L('Video & media',{de:'Video & Medien',ru:'Видео и медиа',lt:'Vaizdas ir medija',es:'Vídeo y medios',pl:'Wideo i media',uk:'Відео та медіа'}),
  'audio':       L('Audio & music',{de:'Audio & Musik',ru:'Аудио и музыка',lt:'Garsas ir muzika',es:'Audio y música',pl:'Dźwięk i muzyka',uk:'Аудіо та музика'}),
  'design':      L('Design & visual',{de:'Design & Grafik',ru:'Дизайн и графика',lt:'Dizainas ir grafika',es:'Diseño y gráficos',pl:'Design i grafika',uk:'Дизайн та графіка'}),
  'writing':     L('Writing & content',{de:'Text & Content',ru:'Тексты и контент',lt:'Tekstai ir turinys',es:'Redacción y contenido',pl:'Teksty i treści',uk:'Тексти та контент'}),
  'marketing':   L('Marketing & social media',{de:'Marketing & Social Media',ru:'Маркетинг и соцсети',lt:'Rinkodara ir socialiniai tinklai',es:'Marketing y redes sociales',pl:'Marketing i social media',uk:'Маркетинг та соцмережі'}),
  'development': L('Development & technology',{de:'Entwicklung & Technik',ru:'Разработка и технологии',lt:'Programavimas ir technologijos',es:'Desarrollo y tecnología',pl:'Programowanie i technologia',uk:'Розробка та технології'}),
};

// ---------- filters ----------
// kind: price | languages | location | availability | multi | single | bool | range | tags
// match: for multi — 'any' (client picks several, a professional needs one) or 'all'
const opt = (key, labels) => ({ key, labels });
// proper nouns (software, platforms, frameworks): the same word in every language, so English only
const names = list => list.map(n => opt(n.toLowerCase().replace(/[^a-z0-9]+/g,'_').replace(/^_|_$/g,''), L(n)));
// concept options: English here, the other six languages come from professions/tr-<lang>.json
const en = pairs => pairs.map(([k, s]) => opt(k, L(s)));

const software = names(['Premiere Pro','DaVinci Resolve','Final Cut Pro','After Effects','CapCut','Blender','Cinema 4D','Photoshop','Lightroom','Illustrator','Audition','Pro Tools','Logic Pro','Nuke','Unreal Engine','Figma','Canva']);
const videoSkills = en([['motion_graphics','Motion graphics'],['color_grading','Color grading'],['sound_design','Sound design'],['subtitles','Subtitles & captions'],
  ['thumbnails','Thumbnails'],['vfx','VFX & compositing'],['green_screen','Green screen'],['multicam','Multicam'],['drone','Drone footage'],
  ['storytelling','Storytelling & scripting'],['talking_head','Talking-head editing'],['short_hooks','Short-form hooks'],['three_d','3D'],
  ['ai_tools','AI tools'],['retouching','Photo retouching'],['live_streaming','Live streaming']]);
const langNames = ['English','Lithuanian','German','Russian','Ukrainian','Polish','Spanish','French','Italian','Portuguese','Dutch','Latvian','Estonian','Swedish','Norwegian','Danish','Finnish','Czech','Turkish','Arabic','Hindi','Chinese','Japanese','Korean']
  .map(n => opt(n, L(n)));   // the key is the English name: that is what editor_profiles.languages already stores

const filters = [
  // ---------- shared by everyone ----------
  { key:'price',        kind:'price',        labels:L('Price',{de:'Preis',ru:'Цена',lt:'Kaina',es:'Precio',pl:'Cena',uk:'Ціна'}) },
  { key:'languages',    kind:'languages',    match:'all', options:langNames, labels:L('Languages',{de:'Sprachen',ru:'Языки',lt:'Kalbos',es:'Idiomas',pl:'Języki',uk:'Мови'}) },
  { key:'location',     kind:'location',     labels:L('Location',{de:'Standort',ru:'Местоположение',lt:'Vieta',es:'Ubicación',pl:'Lokalizacja',uk:'Місце'}) },
  { key:'availability', kind:'availability', labels:L('Availability',{de:'Verfügbarkeit',ru:'Доступность',lt:'Užimtumas',es:'Disponibilidad',pl:'Dostępność',uk:'Доступність'}) },
  { key:'remote',       kind:'bool',         labels:L('Works remotely',{de:'Arbeitet remote',ru:'Работает удалённо',lt:'Dirba nuotoliniu būdu',es:'Trabaja en remoto',pl:'Pracuje zdalnie',uk:'Працює віддалено'}) },
  { key:'skills',       kind:'tags',         labels:L('Skills',{de:'Fähigkeiten',ru:'Навыки',lt:'Įgūdžiai',es:'Habilidades',pl:'Umiejętności',uk:'Навички'}) },
  { key:'turnaround_days', kind:'range', min:1, max:60, unit:'days', labels:L('Turnaround',{de:'Bearbeitungszeit',ru:'Срок выполнения',lt:'Atlikimo laikas',es:'Plazo de entrega',pl:'Czas realizacji',uk:'Термін виконання'}) },
  { key:'industries',   kind:'tags', labels:L('Industry experience',{de:'Branchenerfahrung',ru:'Опыт в отраслях',lt:'Patirtis srityse',es:'Experiencia por sector',pl:'Doświadczenie branżowe',uk:'Галузевий досвід'}) },

  // ---------- video & media ----------
  { key:'video_specialty', kind:'multi', match:'any', custom:true, labels:L('Specialisation',{de:'Spezialisierung',ru:'Специализация',lt:'Specializacija',es:'Especialización',pl:'Specjalizacja',uk:'Спеціалізація'}),
    options:[...['catCommercial','catYoutubeLong','catShorts','catDocumentary','catPodcasts','catMusic','catWedding','catCorporate','catRealEstate','catGaming','catEducation','catMotion','catColor','catTravel'].map(k=>opt(k,cat(k))),
      opt('catTrailers', L('Trailers & teasers',{de:'Trailer & Teaser',ru:'Трейлеры и тизеры',lt:'Anonsai ir tizeriai',es:'Tráilers y teasers',pl:'Zwiastuny i teasery',uk:'Трейлери та тизери'})),
      opt('catAds', L('Ads & performance creatives',{de:'Werbung & Performance-Creatives',ru:'Реклама и перформанс-креативы',lt:'Reklamos ir performance kūriniai',es:'Anuncios y creatividades de rendimiento',pl:'Reklamy i kreacje performance',uk:'Реклама та перформанс-креативи'})),
      opt('catInterviews', L('Interviews & talking heads',{de:'Interviews & Talking Heads',ru:'Интервью и говорящие головы',lt:'Interviu ir kalbančios galvos',es:'Entrevistas y bustos parlantes',pl:'Wywiady i talking heads',uk:'Інтерв’ю та говорячі голови'})),
      opt('catOther', cat('catOther'))] },
  { key:'software',     kind:'multi', match:'any', custom:true, options:software, labels:L('Software',{de:'Software',ru:'Программы',lt:'Programos',es:'Software',pl:'Programy',uk:'Програми'}) },
  { key:'video_skills', kind:'multi', match:'any', custom:true, options:videoSkills, labels:L('Editing skills',{de:'Schnitt-Fähigkeiten',ru:'Навыки монтажа',lt:'Montažo įgūdžiai',es:'Habilidades de edición',pl:'Umiejętności montażu',uk:'Навички монтажу'}) },
  { key:'shoot_place',  kind:'single', labels:L('Where they shoot',{de:'Wo gedreht wird',ru:'Где снимает',lt:'Kur filmuoja / fotografuoja',es:'Dónde trabaja',pl:'Gdzie pracuje',uk:'Де знімає'}),
    options:[opt('studio',L('Studio')),opt('on_location',L('On location',{de:'Vor Ort',ru:'На выезде',lt:'Vietoje',es:'En exteriores',pl:'W plenerze',uk:'На виїзді'})),opt('both',L('Studio and on location',{de:'Studio und vor Ort',ru:'Студия и выезд',lt:'Studija ir vietoje',es:'Estudio y exteriores',pl:'Studio i plener',uk:'Студія та виїзд'}))] },
  { key:'travel_km',    kind:'range', min:0, max:1000, unit:'km', labels:L('Travel radius',{de:'Anfahrtsradius',ru:'Радиус выезда',lt:'Atvyksta iki',es:'Radio de desplazamiento',pl:'Zasięg dojazdu',uk:'Радіус виїзду'}) },
  { key:'equipment',    kind:'tags', labels:L('Equipment',{de:'Ausrüstung',ru:'Оборудование',lt:'Įranga',es:'Equipo',pl:'Sprzęt',uk:'Обладнання'}) },
  { key:'color_work',   kind:'multi', match:'any', custom:true, labels:L('Grading work',{de:'Farbarbeiten',ru:'Работа с цветом',lt:'Spalvų darbai',es:'Trabajo de color',pl:'Praca z kolorem',uk:'Робота з кольором'}),
    options:en([['shot_matching','Shot matching'],['log_raw','Log & RAW workflows'],['film_emulation','Film look & emulation'],['lut_creation','LUT creation'],
      ['skin_tones','Skin tone work'],['hdr','HDR delivery'],['aces','ACES pipeline'],['restoration','Footage restoration'],['beauty_cleanup','Beauty & cleanup']]) },
  { key:'drone_work',   kind:'multi', match:'any', custom:true, labels:L('Aerial work',{de:'Luftaufnahmen',ru:'Съёмка с воздуха',lt:'Filmavimas iš oro',es:'Trabajo aéreo',pl:'Zdjęcia z powietrza',uk:'Зйомка з повітря'}),
    options:en([['real_estate','Real estate & property'],['events','Weddings & events'],['construction','Construction & survey'],['sport','Sport & action'],
      ['landscape','Cinematic landscape'],['inspection','Inspection'],['mapping','Mapping & 3D models'],['fpv','FPV flying'],['indoor','Indoor flying']]) },
  { key:'drone_licensed', kind:'bool', labels:L('Licensed & insured',{de:'Lizenziert & versichert',ru:'Лицензия и страховка',lt:'Licencijuotas ir apdraustas',es:'Con licencia y seguro',pl:'Licencja i ubezpieczenie',uk:'Ліцензія та страховка'}) },
  { key:'anim_style',   kind:'multi', match:'any', custom:true, labels:L('Animation style',{de:'Animationsstil',ru:'Стиль анимации',lt:'Animacijos stilius',es:'Estilo de animación',pl:'Styl animacji',uk:'Стиль анімації'}),
    options:en([['two_d','2D animation'],['three_d','3D animation'],['character','Character animation'],['whiteboard','Whiteboard animation'],
      ['stop_motion','Stop motion'],['cut_out','Cut-out & puppet'],['frame_by_frame','Frame by frame'],['rotoscoping','Rotoscoping'],['pixel','Pixel & retro']]) },
  { key:'anim_software',kind:'multi', match:'any', custom:true, options:names(['After Effects','Blender','Cinema 4D','Maya','Toon Boom Harmony','Moho','Adobe Animate','Spine','Unreal Engine','Houdini','Procreate Dreams','Rive']),
    labels:L('Animation software',{de:'Animations-Software',ru:'Программы для анимации',lt:'Animacijos programos',es:'Software de animación',pl:'Programy do animacji',uk:'Програми для анімації'}) },
  { key:'motion_type',  kind:'multi', match:'any', custom:true, labels:L('Type of work',{de:'Art der Arbeit',ru:'Тип работ',lt:'Darbų tipas',es:'Tipo de trabajo',pl:'Rodzaj pracy',uk:'Тип робіт'}),
    options:en([['explainer','Explainer videos'],['logo_animation','Logo animation'],['titles','Titles & lower thirds'],['ui_animation','UI animation'],
      ['three_d','3D'],['character','Character animation'],['social','Social media motion'],['infographics','Animated infographics'],['product','Product animation']]) },

  // ---------- photography ----------
  { key:'shoot_type',   kind:'multi', match:'any', custom:true, labels:L('Shoot type',{de:'Art des Shootings',ru:'Тип съёмки',lt:'Fotosesijos tipas',es:'Tipo de sesión',pl:'Rodzaj sesji',uk:'Тип зйомки'}),
    options:en([['portrait','Portrait'],['product','Product'],['wedding','Wedding'],['event','Event'],['fashion','Fashion'],['real_estate','Real estate'],
      ['food','Food'],['sports','Sports'],['travel','Travel'],['newborn','Newborn & family'],['corporate','Corporate & headshots'],['other','Other']]) },
  { key:'editing_included', kind:'bool', labels:L('Editing included',{de:'Bearbeitung inklusive',ru:'Обработка включена',lt:'Redagavimas įskaičiuotas',es:'Edición incluida',pl:'Obróbka w cenie',uk:'Обробка включена'}) },
  { key:'delivery_days', kind:'range', min:1, max:60, unit:'days', labels:L('Delivery time',{de:'Lieferzeit',ru:'Срок отдачи',lt:'Pristatymo laikas',es:'Tiempo de entrega',pl:'Czas dostarczenia',uk:'Термін віддачі'}) },
  { key:'photo_software', kind:'multi', match:'any', custom:true, options:names(['Lightroom','Photoshop','Capture One','DxO PhotoLab','Luminar Neo','Affinity Photo','Camera Raw']),
    labels:L('Photo software',{de:'Foto-Software',ru:'Программы для фото',lt:'Nuotraukų programos',es:'Software de foto',pl:'Programy do zdjęć',uk:'Програми для фото'}) },
  { key:'retouch_work', kind:'multi', match:'any', custom:true, labels:L('Retouching work',{de:'Retusche-Arbeiten',ru:'Виды ретуши',lt:'Retušo darbai',es:'Trabajo de retoque',pl:'Rodzaje retuszu',uk:'Види ретуші'}),
    options:en([['portrait','Portrait retouching'],['beauty','Beauty & skin'],['product','Product & e-commerce'],['real_estate','Real estate'],
      ['background','Background removal'],['compositing','Compositing & montage'],['color','Colour correction'],['restoration','Old photo restoration'],['batch','Large batches']]) },

  // ---------- audio & music ----------
  { key:'audio_software', kind:'multi', match:'any', custom:true, options:names(['Pro Tools','Logic Pro','Ableton Live','FL Studio','Adobe Audition','Reaper','Cubase','iZotope RX','Studio One','GarageBand','Descript','Audacity','Nuendo']),
    labels:L('Audio software',{de:'Audio-Software',ru:'Программы для звука',lt:'Garso programos',es:'Software de audio',pl:'Programy audio',uk:'Програми для звуку'}) },
  { key:'audio_skills', kind:'multi', match:'any', custom:true, labels:L('Audio skills',{de:'Audio-Fähigkeiten',ru:'Навыки работы со звуком',lt:'Garso įgūdžiai',es:'Habilidades de audio',pl:'Umiejętności audio',uk:'Навички роботи зі звуком'}),
    options:en([['mixing','Mixing'],['mastering','Mastering'],['noise_removal','Noise removal'],['restoration','Audio restoration'],['dialogue','Dialogue editing'],
      ['foley','Foley'],['sfx','Sound effects'],['composition','Composition'],['arrangement','Arrangement'],['adr','Dubbing & ADR'],['ai_audio','AI audio tools'],['spatial','Surround & spatial audio']]) },
  { key:'sound_work',   kind:'multi', match:'any', custom:true, labels:L('Sound for',{de:'Sound für',ru:'Звук для',lt:'Garsas kam',es:'Sonido para',pl:'Dźwięk do',uk:'Звук для'}),
    options:en([['film','Film & video'],['games','Games'],['ads','Ads & trailers'],['podcasts','Podcasts'],['apps','Apps & interfaces'],
      ['animation','Animation'],['branding','Sound branding'],['installations','Installations & events']]) },
  { key:'audio_edit_work', kind:'multi', match:'any', custom:true, labels:L('Editing work',{de:'Schnittarbeiten',ru:'Виды монтажа',lt:'Montažo darbai',es:'Trabajo de edición',pl:'Rodzaje montażu',uk:'Види монтажу'}),
    options:en([['podcast','Podcast episodes'],['audiobook','Audiobooks'],['interview','Interviews'],['music','Music tracks'],['video_audio','Audio for video'],
      ['transcription','Transcription'],['show_notes','Show notes & chapters'],['clips','Short clips for social']]) },
  { key:'voice_style',  kind:'multi', match:'any', custom:true, labels:L('Voice style',{de:'Sprechstil',ru:'Стиль озвучки',lt:'Įgarsinimo stilius',es:'Estilo de voz',pl:'Styl lektorski',uk:'Стиль озвучення'}),
    options:en([['commercial','Commercial'],['narration','Narration & documentary'],['elearning','E-learning'],['audiobook','Audiobook'],
      ['character','Character & animation'],['trailer','Trailer'],['ivr','Phone & IVR'],['dubbing','Dubbing'],['youtube','YouTube & social']]) },
  { key:'voice_studio', kind:'bool', labels:L('Own recording studio',{de:'Eigenes Aufnahmestudio',ru:'Своя студия записи',lt:'Nuosava įrašų studija',es:'Estudio de grabación propio',pl:'Własne studio nagrań',uk:'Власна студія запису'}) },
  { key:'music_work',   kind:'multi', match:'any', custom:true, labels:L('Music work',{de:'Musikarbeiten',ru:'Музыкальные работы',lt:'Muzikos darbai',es:'Trabajo musical',pl:'Prace muzyczne',uk:'Музичні роботи'}),
    options:en([['original_score','Original score'],['beats','Beat production'],['jingles','Jingles & idents'],['song_production','Song production'],
      ['mixing','Mixing'],['mastering','Mastering'],['arrangement','Arrangement'],['library','Library & stock music'],['live_session','Session musician']]) },

  // ---------- design & visual ----------
  { key:'design_software', kind:'multi', match:'any', custom:true, options:names(['Photoshop','Illustrator','InDesign','Figma','Canva','Affinity Designer','Affinity Photo','CorelDRAW','Sketch','Adobe XD','Procreate','Lightroom','After Effects','Blender']),
    labels:L('Design software',{de:'Design-Software',ru:'Программы для дизайна',lt:'Dizaino programos',es:'Software de diseño',pl:'Programy do projektowania',uk:'Програми для дизайну'}) },
  { key:'design_skills', kind:'multi', match:'any', custom:true, labels:L('Design skills',{de:'Design-Fähigkeiten',ru:'Навыки дизайна',lt:'Dizaino įgūdžiai',es:'Habilidades de diseño',pl:'Umiejętności projektowe',uk:'Навички дизайну'}),
    options:en([['typography','Typography'],['layout','Layout & composition'],['colour','Colour theory'],['vector','Vector illustration'],['photo_editing','Photo editing'],
      ['print_ready','Print preparation'],['prototyping','Prototyping'],['design_systems','Design systems'],['brand_consistency','Brand consistency'],
      ['accessibility','Accessibility'],['ai_images','AI image tools'],['animation','Simple animation']]) },
  { key:'design_work',  kind:'multi', match:'any', custom:true, labels:L('Design work',{de:'Art des Designs',ru:'Виды дизайна',lt:'Dizaino darbai',es:'Tipo de diseño',pl:'Rodzaje projektów',uk:'Види дизайну'}),
    options:en([['social_graphics','Social media graphics'],['ads_banners','Ads & banners'],['print','Print & packaging'],['posters','Posters & flyers'],
      ['book_layout','Book & magazine layout'],['merch','Merch & apparel'],['infographics','Infographics'],['menus','Menus & price lists'],
      ['signage','Signage & large format'],['templates','Reusable templates']]) },
  { key:'brand_work',   kind:'multi', match:'any', custom:true, labels:L('Branding work',{de:'Branding-Arbeiten',ru:'Работы по брендингу',lt:'Prekės ženklo darbai',es:'Trabajo de marca',pl:'Prace brandingowe',uk:'Роботи з брендингу'}),
    options:en([['logo','Logo design'],['identity','Full brand identity'],['guidelines','Brand guidelines'],['naming','Naming'],['rebrand','Rebrand & refresh'],
      ['strategy','Brand strategy'],['stationery','Stationery & business cards'],['packaging','Packaging'],['social_kit','Social media kit']]) },
  { key:'uiux_work',    kind:'multi', match:'any', custom:true, labels:L('UI/UX work',{de:'UI/UX-Arbeiten',ru:'Работы UI/UX',lt:'UI/UX darbai',es:'Trabajo UI/UX',pl:'Prace UI/UX',uk:'Роботи UI/UX'}),
    options:en([['website','Website design'],['app','Mobile app design'],['landing','Landing pages'],['dashboard','Dashboards & admin'],['wireframes','Wireframes & prototypes'],
      ['design_system','Design systems'],['research','User research'],['usability','Usability testing'],['redesign','Redesign of an existing product'],['webshop','Online shop']]) },
  { key:'illus_style',  kind:'multi', match:'any', custom:true, labels:L('Illustration style',{de:'Illustrationsstil',ru:'Стиль иллюстрации',lt:'Iliustracijos stilius',es:'Estilo de ilustración',pl:'Styl ilustracji',uk:'Стиль ілюстрації'}),
    options:en([['vector','Vector & flat'],['hand_drawn','Hand drawn'],['watercolour','Watercolour'],['digital_painting','Digital painting'],['children','Children’s books'],
      ['comic','Comics & manga'],['character','Character design'],['icons','Icons & pictograms'],['editorial','Editorial & press'],['tattoo','Tattoo & merch'],['realistic','Realistic'],['three_d_look','3D look']]) },
  { key:'three_d_work', kind:'multi', match:'any', custom:true, labels:L('3D work',{de:'3D-Arbeiten',ru:'3D-работы',lt:'3D darbai',es:'Trabajo 3D',pl:'Prace 3D',uk:'3D-роботи'}),
    options:en([['product_viz','Product visualisation'],['archviz','Architectural visualisation'],['character_model','Character modelling'],['environment','Environment art'],
      ['game_assets','Game assets'],['printing','3D printing models'],['texturing','Texturing & materials'],['sculpting','Sculpting'],['animation','3D animation'],['cad','CAD & technical']]) },
  { key:'three_d_software', kind:'multi', match:'any', custom:true, options:names(['Blender','Cinema 4D','Maya','3ds Max','ZBrush','Houdini','SketchUp','Substance Painter','KeyShot','Unreal Engine','Rhino','Fusion 360','Marvelous Designer']),
    labels:L('3D software',{de:'3D-Software',ru:'Программы для 3D',lt:'3D programos',es:'Software 3D',pl:'Programy 3D',uk:'Програми для 3D'}) },
  { key:'deck_work',    kind:'multi', match:'any', custom:true, labels:L('Presentation type',{de:'Art der Präsentation',ru:'Тип презентации',lt:'Prezentacijos tipas',es:'Tipo de presentación',pl:'Rodzaj prezentacji',uk:'Тип презентації'}),
    options:en([['pitch','Pitch deck'],['investor','Investor deck'],['sales','Sales deck'],['conference','Conference talk'],['training','Training & webinar'],
      ['report','Report & data deck'],['template','Reusable template'],['redesign','Redesign of my slides']]) },
  { key:'deck_software', kind:'multi', match:'any', custom:true, options:names(['PowerPoint','Google Slides','Keynote','Figma','Canva','Pitch','Prezi']),
    labels:L('Presentation software',{de:'Präsentations-Software',ru:'Программы для презентаций',lt:'Prezentacijų programos',es:'Software de presentaciones',pl:'Programy do prezentacji',uk:'Програми для презентацій'}) },

  // ---------- writing & content ----------
  { key:'writing_type', kind:'multi', match:'any', custom:true, labels:L('Writing type',{de:'Textart',ru:'Тип текстов',lt:'Tekstų tipas',es:'Tipo de texto',pl:'Rodzaj tekstów',uk:'Тип текстів'}),
    options:en([['advertising','Advertising'],['email','Email'],['landing_pages','Landing pages'],['seo','SEO articles'],['blog','Blog writing'],
      ['script','Scriptwriting'],['technical','Technical writing'],['social','Social media'],['product','Product descriptions'],['press','Press & PR'],['ux_copy','UX & app copy']]) },
  { key:'writing_skills', kind:'multi', match:'any', custom:true, labels:L('Writing skills',{de:'Text-Fähigkeiten',ru:'Навыки письма',lt:'Rašymo įgūdžiai',es:'Habilidades de redacción',pl:'Umiejętności pisarskie',uk:'Навички письма'}),
    options:en([['seo_writing','SEO writing'],['keyword_research','Keyword research'],['research','Research'],['interviewing','Interviewing'],['storytelling','Storytelling'],
      ['tone_of_voice','Tone of voice'],['editing','Editing & proofreading'],['fact_checking','Fact-checking'],['ghostwriting','Ghostwriting'],
      ['conversion','Conversion copy'],['localisation','Localisation'],['ai_writing','AI writing tools']]) },
  { key:'writing_tools', kind:'multi', match:'any', custom:true, options:names(['Google Docs','Microsoft Word','Grammarly','Notion','Scrivener','WordPress','Final Draft','Surfer SEO','Semrush','Ahrefs']),
    labels:L('Writing tools',{de:'Text-Tools',ru:'Инструменты для текстов',lt:'Rašymo įrankiai',es:'Herramientas de redacción',pl:'Narzędzia pisarskie',uk:'Інструменти для текстів'}) },
  { key:'script_type',  kind:'multi', match:'any', custom:true, labels:L('Script type',{de:'Art des Drehbuchs',ru:'Тип сценария',lt:'Scenarijaus tipas',es:'Tipo de guion',pl:'Rodzaj scenariusza',uk:'Тип сценарію'}),
    options:en([['youtube','YouTube videos'],['ads','Ads & commercials'],['explainer','Explainer videos'],['short_film','Short film'],['feature','Feature film'],
      ['documentary','Documentary'],['podcast','Podcast'],['series','TV & series'],['game','Game narrative'],['storyboard','Storyboards']]) },
  { key:'translation_work', kind:'multi', match:'any', custom:true, labels:L('Translation work',{de:'Übersetzungsarbeiten',ru:'Виды перевода',lt:'Vertimo darbai',es:'Trabajo de traducción',pl:'Rodzaje tłumaczeń',uk:'Види перекладу'}),
    options:en([['documents','Documents'],['website','Website localisation'],['subtitles','Subtitles'],['app','App & software localisation'],
      ['marketing','Marketing transcreation'],['technical','Technical'],['legal','Legal'],['certified','Certified translation'],
      ['proofreading','Proofreading a translation'],['transcription','Transcription']]) },
  { key:'translation_tools', kind:'multi', match:'any', custom:true, options:names(['Trados','memoQ','Smartcat','Phrase','Crowdin','Subtitle Edit','Aegisub','MateCat']),
    labels:L('Translation tools',{de:'Übersetzungs-Tools',ru:'Инструменты перевода',lt:'Vertimo įrankiai',es:'Herramientas de traducción',pl:'Narzędzia tłumaczeniowe',uk:'Інструменти перекладу'}) },
  { key:'proofread_work', kind:'multi', match:'any', custom:true, labels:L('Editing work',{de:'Lektorats-Arbeiten',ru:'Виды редактуры',lt:'Redagavimo darbai',es:'Trabajo de corrección',pl:'Rodzaje redakcji',uk:'Види редагування'}),
    options:en([['proofreading','Proofreading'],['copy_editing','Copy-editing'],['developmental','Developmental editing'],['academic','Academic & thesis'],
      ['fact_checking','Fact-checking'],['style_guide','Style guide & formatting'],['book','Books & long form'],['translation_check','Checking a translation']]) },

  // ---------- marketing & social media ----------
  { key:'social_platform', kind:'multi', match:'any', custom:true, options:names(['Instagram','TikTok','YouTube','Facebook','LinkedIn','Pinterest','Threads','Snapchat','Reddit','X']),
    labels:L('Platforms',{de:'Plattformen',ru:'Площадки',lt:'Platformos',es:'Plataformas',pl:'Platformy',uk:'Платформи'}) },
  { key:'social_work',  kind:'multi', match:'any', custom:true, labels:L('Social media work',{de:'Social-Media-Arbeiten',ru:'Работы в соцсетях',lt:'Socialinių tinklų darbai',es:'Trabajo en redes',pl:'Prace w social media',uk:'Роботи в соцмережах'}),
    options:en([['strategy','Content strategy'],['planning','Content planning'],['posting','Posting & scheduling'],['community','Community management'],
      ['short_video','Short-form video'],['captions','Captions & copy'],['influencers','Influencer outreach'],['reporting','Analytics & reporting'],
      ['growth','Account growth'],['collab','Collaborations & giveaways']]) },
  { key:'marketing_skills', kind:'multi', match:'any', custom:true, labels:L('Marketing skills',{de:'Marketing-Fähigkeiten',ru:'Навыки маркетинга',lt:'Rinkodaros įgūdžiai',es:'Habilidades de marketing',pl:'Umiejętności marketingowe',uk:'Навички маркетингу'}),
    options:en([['copywriting','Copywriting'],['analytics','Analytics & reporting'],['ab_testing','A/B testing'],['funnels','Funnel building'],
      ['email_marketing','Email marketing'],['landing_pages','Landing pages'],['budget','Budget management'],['creative_testing','Creative testing'],
      ['audience','Audience research'],['crm','CRM & automation']]) },
  { key:'marketing_tools', kind:'multi', match:'any', custom:true, options:names(['Google Analytics','Google Ads','Meta Business Suite','Google Search Console','HubSpot','Mailchimp','Klaviyo','Ahrefs','Semrush','Later','Buffer','Hootsuite','Canva','Looker Studio']),
    labels:L('Marketing tools',{de:'Marketing-Tools',ru:'Инструменты маркетинга',lt:'Rinkodaros įrankiai',es:'Herramientas de marketing',pl:'Narzędzia marketingowe',uk:'Інструменти маркетингу'}) },
  { key:'ads_platform', kind:'multi', match:'any', custom:true, options:names(['Meta Ads','Google Ads','TikTok Ads','LinkedIn Ads','YouTube Ads','Pinterest Ads','Microsoft Ads','Amazon Ads','Spotify Ads']),
    labels:L('Ad platforms',{de:'Werbeplattformen',ru:'Рекламные площадки',lt:'Reklamos platformos',es:'Plataformas de anuncios',pl:'Platformy reklamowe',uk:'Рекламні платформи'}) },
  { key:'ads_goal',     kind:'multi', match:'any', custom:true, labels:L('Campaign goal',{de:'Kampagnenziel',ru:'Цель кампании',lt:'Kampanijos tikslas',es:'Objetivo de la campaña',pl:'Cel kampanii',uk:'Мета кампанії'}),
    options:en([['sales','Online sales'],['leads','Leads & enquiries'],['traffic','Website traffic'],['awareness','Brand awareness'],
      ['app_installs','App installs'],['local','Local customers'],['retargeting','Retargeting'],['setup','First-time setup']]) },
  { key:'seo_work',     kind:'multi', match:'any', custom:true, labels:L('SEO work',{de:'SEO-Arbeiten',ru:'Работы по SEO',lt:'SEO darbai',es:'Trabajo SEO',pl:'Prace SEO',uk:'Роботи з SEO'}),
    options:en([['audit','SEO audit'],['technical','Technical SEO'],['on_page','On-page SEO'],['content_strategy','Content strategy'],['keyword_research','Keyword research'],
      ['link_building','Link building'],['local','Local SEO'],['ecommerce','E-commerce SEO'],['international','International SEO'],['migration','Site migration']]) },
  { key:'ugc_work',     kind:'multi', match:'any', custom:true, labels:L('UGC formats',{de:'UGC-Formate',ru:'Форматы UGC',lt:'UGC formatai',es:'Formatos UGC',pl:'Formaty UGC',uk:'Формати UGC'}),
    options:en([['unboxing','Unboxing'],['demo','Product demo'],['testimonial','Testimonial'],['tutorial','Tutorial & how-to'],['grwm','Get ready with me'],
      ['before_after','Before & after'],['voiceover','Voice-over UGC'],['reaction','Reaction & green screen'],['lifestyle','Lifestyle & day in the life']]) },

  // ---------- development & technology ----------
  { key:'dev_area',     kind:'multi', match:'any', labels:L('Area',{de:'Bereich',ru:'Направление',lt:'Sritis',es:'Área',pl:'Obszar',uk:'Напрям'}),
    options:en([['frontend','Frontend'],['backend','Backend'],['fullstack','Full-stack'],['mobile','Mobile'],['ecommerce','E-commerce'],['devops','DevOps']]) },
  { key:'dev_work',     kind:'multi', match:'any', custom:true, labels:L('What is needed',{de:'Was gebraucht wird',ru:'Что нужно сделать',lt:'Ko reikia',es:'Qué se necesita',pl:'Co jest potrzebne',uk:'Що потрібно'}),
    options:en([['new_site','A new website'],['redesign','Redesign'],['new_app','A new app'],['feature','A new feature'],['bug_fixing','Bug fixing & support'],
      ['integration','API & integrations'],['ecommerce','Online shop'],['performance','Speed & performance'],['migration','Migration'],
      ['automation','Automation'],['maintenance','Ongoing maintenance']]) },
  { key:'dev_skills',   kind:'multi', match:'any', custom:true, labels:L('Development skills',{de:'Entwicklungs-Fähigkeiten',ru:'Навыки разработки',lt:'Programavimo įgūdžiai',es:'Habilidades de desarrollo',pl:'Umiejętności programistyczne',uk:'Навички розробки'}),
    options:en([['responsive','Responsive design'],['api','API integration'],['databases','Databases'],['performance','Performance & speed'],['seo_basics','SEO basics'],
      ['accessibility','Accessibility'],['testing','Testing'],['deployment','Deployment & CI'],['security','Security'],['payments','Payments'],
      ['analytics','Analytics setup'],['ai_integration','AI integration']]) },
  { key:'framework',    kind:'multi', match:'any', custom:true, options:names(['React','Vue','Angular','Next.js','Svelte','Node.js','Django','Laravel','Rails','WordPress','Shopify','Astro','Supabase']),
    labels:L('Frameworks',{de:'Frameworks',ru:'Фреймворки',lt:'Karkasai',es:'Frameworks',pl:'Frameworki',uk:'Фреймворки'}) },
  { key:'prog_lang',    kind:'multi', match:'any', custom:true, options:names(['JavaScript','TypeScript','Python','PHP','Ruby','Go','Java','C#','Swift','Kotlin','Dart','Rust']),
    labels:L('Programming languages',{de:'Programmiersprachen',ru:'Языки программирования',lt:'Programavimo kalbos',es:'Lenguajes de programación',pl:'Języki programowania',uk:'Мови програмування'}) },
  { key:'mobile_platform', kind:'multi', match:'any', custom:true, options:names(['iOS','Android','Flutter','React Native','Kotlin Multiplatform','Progressive web app']),
    labels:L('Mobile platforms',{de:'Mobile Plattformen',ru:'Мобильные платформы',lt:'Mobiliosios platformos',es:'Plataformas móviles',pl:'Platformy mobilne',uk:'Мобільні платформи'}) },
  { key:'nocode_tool',  kind:'multi', match:'any', custom:true, options:names(['WordPress','Webflow','Shopify','Squarespace','Wix','Framer','Bubble','Zapier','Make','Airtable','Notion','Softr','Elementor']),
    labels:L('No-code tools',{de:'No-Code-Tools',ru:'No-code инструменты',lt:'No-code įrankiai',es:'Herramientas no-code',pl:'Narzędzia no-code',uk:'No-code інструменти'}) },
  { key:'game_engine',  kind:'multi', match:'any', custom:true, options:names(['Unity','Unreal Engine','Godot','GameMaker','Construct','Roblox Studio','Phaser']),
    labels:L('Game engines',{de:'Game-Engines',ru:'Игровые движки',lt:'Žaidimų varikliai',es:'Motores de juego',pl:'Silniki gier',uk:'Ігрові рушії'}) },
  { key:'work_mode',    kind:'single', labels:L('Availability type',{de:'Art der Verfügbarkeit',ru:'Формат занятости',lt:'Užimtumo forma',es:'Tipo de disponibilidad',pl:'Forma dostępności',uk:'Формат зайнятості'}),
    options:[opt('full_time',L('Full-time',{de:'Vollzeit',ru:'Полная занятость',lt:'Visą darbo dieną',es:'Jornada completa',pl:'Pełny etat',uk:'Повна зайнятість'})),opt('part_time',L('Part-time',{de:'Teilzeit',ru:'Частичная занятость',lt:'Ne visą darbo dieną',es:'Media jornada',pl:'Część etatu',uk:'Часткова зайнятість'})),opt('project',L('Project basis',{de:'Projektbasis',ru:'Проектно',lt:'Pagal projektus',es:'Por proyecto',pl:'Projektowo',uk:'Проєктно'}))] },
];

// ---------- which filters each profession uses, in order; primary = shown in the chip row ----------
// The job form shows every 'multi' filter here, in this order, once a profession is chosen.
const P = (key, primary, profile=true) => ({ key, primary, profile });
const professionFilters = {
  // video & media
  'video-editor':   [P('price',true),P('video_specialty',true),P('video_skills',true),P('software',true),P('turnaround_days',false),P('languages',false),P('location',false),P('availability',true),P('remote',false),P('skills',false)],
  'videographer':   [P('price',true),P('video_specialty',true),P('video_skills',false),P('software',false),P('shoot_place',false),P('travel_km',false),P('equipment',false),P('turnaround_days',false),P('languages',false),P('location',true),P('availability',true),P('skills',false)],
  'photographer':   [P('price',true),P('shoot_type',true),P('photo_software',false),P('shoot_place',false),P('travel_km',false),P('editing_included',true),P('delivery_days',false),P('equipment',false),P('languages',false),P('location',true),P('availability',true),P('skills',false)],
  'motion-designer':[P('price',true),P('motion_type',true),P('anim_software',true),P('software',false),P('video_skills',false),P('turnaround_days',false),P('languages',false),P('location',false),P('availability',true),P('remote',false),P('skills',false)],
  'animator':       [P('price',true),P('anim_style',true),P('motion_type',false),P('anim_software',true),P('turnaround_days',false),P('languages',false),P('location',false),P('availability',true),P('remote',false),P('skills',false)],
  'colorist':       [P('price',true),P('color_work',true),P('video_specialty',false),P('software',true),P('turnaround_days',false),P('languages',false),P('location',false),P('availability',true),P('remote',false),P('skills',false)],
  'drone-operator': [P('price',true),P('drone_work',true),P('drone_licensed',true),P('equipment',false),P('video_skills',false),P('software',false),P('travel_km',false),P('languages',false),P('location',true),P('availability',true),P('skills',false)],
  // audio & music
  'sound-designer': [P('price',true),P('sound_work',true),P('audio_skills',true),P('audio_software',true),P('turnaround_days',false),P('languages',false),P('location',false),P('availability',true),P('remote',false),P('skills',false)],
  'audio-editor':   [P('price',true),P('audio_edit_work',true),P('audio_skills',true),P('audio_software',true),P('turnaround_days',false),P('languages',false),P('location',false),P('availability',true),P('remote',false),P('skills',false)],
  'voice-over':     [P('price',true),P('voice_style',true),P('languages',true),P('voice_studio',true),P('audio_skills',false),P('audio_software',false),P('turnaround_days',false),P('location',false),P('availability',true),P('remote',false),P('skills',false)],
  'music-producer': [P('price',true),P('music_work',true),P('audio_skills',false),P('audio_software',true),P('turnaround_days',false),P('languages',false),P('location',false),P('availability',true),P('remote',false),P('skills',false)],
  // design & visual
  'graphic-designer':[P('price',true),P('design_work',true),P('design_skills',true),P('design_software',true),P('turnaround_days',false),P('industries',false),P('languages',false),P('location',false),P('availability',true),P('remote',false),P('skills',false)],
  'brand-designer': [P('price',true),P('brand_work',true),P('design_skills',false),P('design_software',true),P('turnaround_days',false),P('industries',false),P('languages',false),P('location',false),P('availability',true),P('remote',false),P('skills',false)],
  'ui-ux-designer': [P('price',true),P('uiux_work',true),P('design_skills',true),P('design_software',true),P('turnaround_days',false),P('industries',false),P('languages',false),P('location',false),P('availability',true),P('remote',false),P('skills',false)],
  'illustrator':    [P('price',true),P('illus_style',true),P('design_skills',false),P('design_software',true),P('turnaround_days',false),P('languages',false),P('location',false),P('availability',true),P('remote',false),P('skills',false)],
  'three-d-artist': [P('price',true),P('three_d_work',true),P('three_d_software',true),P('design_skills',false),P('turnaround_days',false),P('languages',false),P('location',false),P('availability',true),P('remote',false),P('skills',false)],
  'presentation-designer':[P('price',true),P('deck_work',true),P('deck_software',true),P('design_skills',false),P('turnaround_days',false),P('industries',false),P('languages',false),P('location',false),P('availability',true),P('remote',false),P('skills',false)],
  'photo-retoucher':[P('price',true),P('retouch_work',true),P('photo_software',true),P('design_skills',false),P('turnaround_days',false),P('languages',false),P('location',false),P('availability',true),P('remote',false),P('skills',false)],
  // writing & content
  'copywriter':     [P('price',true),P('writing_type',true),P('writing_skills',true),P('languages',true),P('writing_tools',false),P('industries',false),P('turnaround_days',false),P('location',false),P('availability',true),P('remote',false),P('skills',false)],
  'content-writer': [P('price',true),P('writing_type',true),P('writing_skills',true),P('languages',true),P('writing_tools',false),P('industries',false),P('turnaround_days',false),P('location',false),P('availability',true),P('remote',false),P('skills',false)],
  'scriptwriter':   [P('price',true),P('script_type',true),P('writing_skills',false),P('languages',true),P('turnaround_days',false),P('industries',false),P('location',false),P('availability',true),P('remote',false),P('skills',false)],
  'translator':     [P('price',true),P('translation_work',true),P('languages',true),P('translation_tools',false),P('industries',false),P('turnaround_days',false),P('location',false),P('availability',true),P('remote',false),P('skills',false)],
  'proofreader':    [P('price',true),P('proofread_work',true),P('languages',true),P('writing_skills',false),P('writing_tools',false),P('industries',false),P('turnaround_days',false),P('location',false),P('availability',true),P('remote',false),P('skills',false)],
  // marketing & social media
  'social-media-manager':[P('price',true),P('social_work',true),P('social_platform',true),P('marketing_skills',false),P('marketing_tools',false),P('industries',false),P('languages',true),P('location',false),P('availability',true),P('remote',false),P('skills',false)],
  'ads-specialist': [P('price',true),P('ads_platform',true),P('ads_goal',true),P('marketing_skills',false),P('marketing_tools',false),P('industries',false),P('languages',false),P('location',false),P('availability',true),P('remote',false),P('skills',false)],
  'seo-specialist': [P('price',true),P('seo_work',true),P('marketing_skills',false),P('marketing_tools',false),P('industries',false),P('languages',false),P('location',false),P('availability',true),P('remote',false),P('skills',false)],
  'ugc-creator':    [P('price',true),P('ugc_work',true),P('social_platform',true),P('video_skills',false),P('languages',true),P('turnaround_days',false),P('location',true),P('availability',true),P('skills',false)],
  // development & technology
  'web-developer':  [P('price',true),P('dev_work',true),P('dev_area',true),P('framework',true),P('prog_lang',false),P('dev_skills',false),P('work_mode',false),P('remote',true),P('languages',false),P('location',false),P('availability',true),P('skills',false)],
  'mobile-developer':[P('price',true),P('dev_work',true),P('mobile_platform',true),P('prog_lang',false),P('dev_skills',false),P('work_mode',false),P('remote',true),P('languages',false),P('location',false),P('availability',true),P('skills',false)],
  'no-code-developer':[P('price',true),P('dev_work',true),P('nocode_tool',true),P('dev_skills',false),P('turnaround_days',false),P('remote',true),P('languages',false),P('location',false),P('availability',true),P('skills',false)],
  'game-developer': [P('price',true),P('game_engine',true),P('dev_work',false),P('prog_lang',false),P('dev_skills',false),P('work_mode',false),P('remote',true),P('languages',false),P('location',false),P('availability',true),P('skills',false)],
};
// filters every profession shares, shown when no profession is chosen
const sharedFilters = ['price','languages','location','availability'];

// price units and their labels
const units = {
  hour:    L('per hour',{de:'pro Stunde',ru:'в час',lt:'už valandą',es:'por hora',pl:'za godzinę',uk:'за годину'}),
  day:     L('per day',{de:'pro Tag',ru:'в день',lt:'už dieną',es:'por día',pl:'za dzień',uk:'за день'}),
  project: L('per project',{de:'pro Projekt',ru:'за проект',lt:'už projektą',es:'por proyecto',pl:'za projekt',uk:'за проєкт'}),
  session: L('per session',{de:'pro Shooting',ru:'за съёмку',lt:'už fotosesiją',es:'por sesión',pl:'za sesję',uk:'за сесію'}),
  word:    L('per word',{de:'pro Wort',ru:'за слово',lt:'už žodį',es:'por palabra',pl:'za słowo',uk:'за слово'}),
  month:   L('per month',{de:'pro Monat',ru:'в месяц',lt:'per mėnesį',es:'al mes',pl:'miesięcznie',uk:'на місяць'}),
};

module.exports = { professions, groups, filters, professionFilters, sharedFilters, units };
