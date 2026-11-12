# FichajeBull — Especificació funcional i legal

**Sistema integral de registre de jornada i parts de servei per a empreses de seguretat privada**
Document per a validació legal i per a l'equip de desenvolupament (sense codi).

Marc normatiu de referència:
- **Estatut dels Treballadors**, art. 34.9 (registre diari de jornada) i art. 35 (hores extraordinàries).
- **RGPD** (Reglament UE 2016/679) i **LOPDGDD** (LO 3/2018), especialment l'art. 90 (geolocalització en l'àmbit laboral).
- Criteris de l'**AEPD** sobre registre de jornada i geolocalització.
- **Conveni col·lectiu estatal d'empreses de seguretat privada** (jornada de còmput mensual/anual, nocturnitat, festius, pauses en llocs unipersonals).
- **LISOS**, art. 21 (conservació de documentació) i criteris de la Inspecció de Treball.

---

## 1. Visió global i arquitectura

| Peça | Funció |
|---|---|
| **Servidor (Node.js)** | Aplica les regles del conveni, garanteix la immutabilitat dels registres, calcula hores i plusos, genera exportacions i serveix les dues interfícies. |
| **Web App del vigilant** (`/app/`) | Aplicació web *mobile-first* instal·lable (PWA), sense passar per Google Play ni App Store. Fitxatge, pauses, prolongacions, parts de servei i consulta d'hores. Funciona sense cobertura. |
| **Panell d'oficina** (`/admin/`) | Per a RRHH, Operacions i Centre de Control (CECOA): estat en temps real, quadrants, correccions auditades, còmput mensual, repositori de parts i exportació per a la Inspecció. |

Base de dades relacional centralitzada. Cada taula de registre (fitxatges, correccions, parts, lectures NFC i log d'auditoria) està protegida a nivell de base de dades contra modificació i esborrat.

### Rols i permisos

| Rol | Accés |
|---|---|
| **Vigilant** | Només la web mòbil: els seus fitxatges, parts i hores. |
| **CECOA** | Dashboard en temps real, consulta de quadrants, registres i parts. |
| **Operacions** | L'anterior + gestió de quadrants, instal·lacions i enviament de parts al client. |
| **RRHH** | L'anterior + correccions auditades, còmput mensual, exportació per a la Inspecció, gestió de personal i auditoria. |
| **Administrador** | Tot, inclosa la configuració del sistema i la purga de dades fora del termini legal. |

Cap rol, ni tan sols l'administrador, pot modificar ni esborrar un registre horari.

---

## 2. Mòdul del vigilant (web mòbil)

### 2.1 Identificació
- L'accés és amb **número de TIP** i contrasenya personal. El TIP és l'identificador únic del treballador al sistema.
- Les contrasenyes es desen xifrades (hash bcrypt) i no es poden recuperar, només restablir.
- Bloqueig temporal de 15 minuts després de 5 intents fallits (per TIP i adreça IP).
- Sessions amb caducitat (14 h per defecte) i registre d'accessos (correctes i fallits) a l'auditoria.

### 2.2 Control de jornada i geolocalització puntual
- Botons grans per: **Iniciar jornada**, **Iniciar pausa**, **Finalitzar pausa** i **Finalitzar jornada**. Només es mostren els botons vàlids segons l'estat (fora de servei / en servei / en pausa).
- **La ubicació GPS es captura únicament en el moment exacte de pitjar el botó.** No hi ha rastreig continu, ni en primer pla ni en segon pla. Ho garanteix el disseny: l'aplicació no té cap procés que demani la ubicació fora de l'acció de fitxar.
- El servidor calcula la distància a la instal·lació assignada i hi aplica un **radi permès** configurable per instal·lació. També té en compte la precisió del GPS, fins a un màxim de 100 m.
- **Fora de radi:** segons la configuració, el sistema **exigeix una justificació escrita** (per defecte) o només n'avisa. En tots dos casos el registre queda marcat per revisar.
- **Sense ubicació** (permís denegat o sense senyal): es demana justificació i el registre queda marcat per revisar.
- El torn i la instal·lació s'assignen automàticament a partir del quadrant. Si el vigilant no té torn, ha de seleccionar la instal·lació i l'entrada queda marcada com a "sense torn planificat".

### 2.3 Pauses (temps d'entrepà)
- En iniciar una pausa, el vigilant indica si **pot abandonar el lloc de servei**.
- Si **no el pot abandonar**, la pausa **computa com a treball efectiu** i no es descompta. Si la instal·lació està configurada com a **lloc unipersonal**, aquest criteri s'aplica automàticament, sense preguntar.
- El còmput mensual mostra per separat les pauses computades i les pauses descomptades.

### 2.4 Demora de relleu (prolongació de jornada)
- Si la sortida es fitxa més tard de l'hora prevista del torn (tolerància configurable, 5 min per defecte), l'aplicació **obliga a seleccionar un motiu**:
  - Espera de relleu
  - Incidència en el servei
  - Ordre del superior / CECOA
  - Altres (amb text obligatori)
- La prolongació (minuts i motiu) es **vincula automàticament al part de servei** del mateix torn i surt en el seu PDF. Al còmput mensual es desglossa per motiu, per justificar-ne el pagament.
- Les sortides anticipades es marquen per revisar.

### 2.5 Part de servei digital
- Formulari tàctil per afegir incidències tipificades: control d'accés, alarma, incidència amb tercers, ronda, avaria, emergència i altres. Cada incidència té hora i descripció.
- També permet indicar "Sense novetats" i afegir observacions lliures.
- Té **signatura manuscrita digital** sobre la pantalla. És obligatòria per enviar el part.
- En rebre el part, el **servidor hi afegeix el segell de temps** (l'hora del servidor, no la del mòbil). El part queda immutable i encadenat amb hash.

### 2.6 Mode sense cobertura (offline)
- L'aplicació es pot instal·lar a la pantalla d'inici i obrir-se sense connexió.
- Sense cobertura (per exemple, en un soterrani), el fitxatge o el part es **desa al mòbil** i la pantalla n'indica els registres pendents.
- En recuperar la connexió, la sincronització és **automàtica** (també es pot forçar manualment).
- **Es respecta l'hora real de l'acció.** El mòbil envia l'hora en què es va pitjar el botó i l'hora d'enviament. El servidor compara aquesta última amb el seu rellotge, calcula el desfasament del rellotge del mòbil i el corregeix. Així no es pot alterar l'hora canviant el rellotge del telèfon.
- Cada registre té un identificador únic generat al mòbil, de manera que reenviar-lo **no crea duplicats**.
- Els registres offline queden marcats com a tals i van a revisió si:
  - la seqüència és incoherent,
  - falta una justificació o un motiu,
  - el rellotge del mòbil anava desfasat més de 5 minuts, o
  - s'han sincronitzat amb més de 7 dies de retard.

---

## 3. Servidor i compliment legal

### 3.1 Còmput mensual d'hores
- La jornada es computa **per mes**: 162 h per defecte, configurable per treballador.
- Els torns llargs (12 h) **no generen alarmes d'hores extraordinàries diàries**. Les hores extra es calculen al **tancament de mes**, com l'excés sobre la jornada del treballador.
- El sistema creua les **hores reals** amb el **quadrant teòric** i mostra la diferència per treballador i dia.
- Els torns que creuen la mitjanit o el canvi de mes es reparteixen correctament entre els dies i mesos corresponents.
- Detecta automàticament aquestes anomalies:
  - entrada sense sortida,
  - sortida sense entrada,
  - pauses incoherents,
  - torn planificat sense cap fitxatge.

### 3.2 Desglossament de plusos
- **Hores nocturnes:** entre les 22:00 i les 06:00 (configurable).
- **Cap de setmana:** dissabte i diumenge.
- **Festius:** calendari de festius configurable (nacionals, autonòmics i locals).
- El càlcul es fa en hora local (Europe/Madrid) i té en compte els canvis d'horari d'estiu i d'hivern.

### 3.3 Immutabilitat i registre d'auditoria
- **A nivell de base de dades**, és impossible modificar qualsevol fitxatge, correcció, part de servei, lectura NFC o entrada del log d'auditoria. També és impossible esborrar-ne cap durant el termini de conservació. La prohibició s'aplica fins i tot a l'administrador del sistema.
- **Correccions:** quan cal corregir un registre (per exemple, un fitxatge oblidat o una hora errònia), RRHH crea una **anotació de correcció** amb:
  - qui la fa,
  - quan la fa,
  - el valor anterior i el valor nou,
  - un **motiu obligatori** (mínim 10 caràcters).

  El registre original es conserva sempre i continua visible. Hi ha tres tipus de correcció: *modificar*, *anul·lar* i *afegir* (fitxatge oblidat).
- **Cadena de hash SHA-256:** cada registre conté l'empremta digital de l'anterior. Una funció de verificació, disponible al panell, detecta qualsevol manipulació feta directament a la base de dades.
- El **log d'auditoria** recull accessos, exportacions, descàrregues i enviaments de parts, canvis de quadrant, d'usuaris i de configuració, i correccions.

### 3.4 Conservació (4 anys)
- Tots els registres es conserven com a mínim **4 anys**. La base de dades impedeix esborrar-ne cap abans d'aquest termini.
- Un cop vençut el termini, un administrador pot executar una **purga** per complir el principi de minimització (art. 5.1.e RGPD). La purga queda auditada.

### 3.5 Exportació per a la Inspecció de Treball
- Exportació massiva en **Excel** o **PDF**, per treballador i per un període de mesos.
- Contingut:
  - registre diari amb hora d'inici i de fi,
  - pauses (indicant si computen),
  - prolongacions amb el seu motiu,
  - origen de cada registre (online, offline o administratiu),
  - geolocalització (dins o fora del radi),
  - correccions amb autor, data i motiu,
  - resum mensual amb hores, nocturnes, cap de setmana, festius i hores extra.
- Cada exportació queda registrada a l'auditoria.

---

## 4. Panell de RRHH i Operacions

- **Temps real:** mostra els torns del dia amb el seu estat:
  - pendent,
  - en servei,
  - en servei amb retard,
  - en pausa,
  - en prolongació,
  - retard (encara sense fitxar),
  - **absent**,
  - finalitzat.

  També inclou indicadors de **llocs crítics descoberts**, alertes de fitxatge fora de radi i registres per revisar, i un flux d'activitat en directe. S'actualitza sol cada cop que algú fitxa.
- **Quadrants:**
  - creació manual de torns,
  - importació massiva per CSV,
  - validació de solapaments i de torns de més de 24 h,
  - cancel·lació de torns (només si encara no tenen fitxatges),
  - comparativa entre quadrant i hores reals.
- **Registres i correccions:** consulta per mes i treballador, filtre de registres pendents de revisió i correccions auditades.
- **Còmput mensual:** taula per treballador i detall diari.
- **Repositori de parts:** filtres per dates, client i tipus d'incidència. Es poden visualitzar amb la signatura, descarregar en PDF i **enviar al client** si el contracte ho exigeix (cal configurar el correu al servidor). Cada enviament queda auditat.
- **Personal, clients i instal·lacions:** alta i baixa de treballadors, rols, jornada mensual individual, coordenades i radi de cada instal·lació, lloc unipersonal i lloc crític.
- **Configuració:** jornada per defecte, franja nocturna, política de geolocalització, toleràncies, festius i termini de conservació.

---

## 5. Preparació per a rondes NFC (fase 2)

L'estructura de dades ja és a punt:
- **Punts de control:** xips NFC associats a una instal·lació.
- **Rutes de ronda:** llista ordenada de punts, amb un temps màxim per completar-la.
- **Assignació de rutes a torns.**
- **Lectures NFC:** immutables, encadenades amb hash, amb marca temporal, geolocalització de suport i vinculació automàtica al torn obert i al part de servei. Funcionen també en mode offline.

Ja estan disponibles el registre de lectures i l'alta de punts de control. La lògica completa de rondes queda per a la fase 2:
- ordre esperat,
- temps màxim,
- alertes de ronda incompleta,
- lectura amb l'API Web NFC des del navegador.

---

## 6. Protecció de dades (resum per a la validació legal)

| Aspecte | Mesura |
|---|---|
| Base jurídica | Compliment d'obligació legal (art. 6.1.c RGPD; art. 34.9 ET). |
| Minimització de la geolocalització | Només en el moment de fitxar; mai durant el torn (art. 90 LOPDGDD). |
| Informació al treballador | Avís a la pantalla d'accés. Cal complementar-lo amb la clàusula informativa i la política interna de l'empresa. |
| Accés | Per rols i amb el mínim privilegi. Cada vigilant només veu les seves dades. |
| Integritat | Immutabilitat a la base de dades, cadena de hash i correccions auditades. |
| Conservació | 4 anys i purga auditada. |
| Seguretat | Contrasenyes amb hash, limitació d'intents, capçaleres de seguretat (CSP, HSTS en producció) i HTTPS obligatori en producció. |
| Dades al dispositiu | Només la cua pendent de sincronitzar i la sessió. S'esborren en sincronitzar o en tancar la sessió. |

**Punts a validar per l'assessoria legal:**
1. Text de la clàusula informativa sobre la geolocalització.
2. Consulta als representants dels treballadors (art. 64 ET i art. 87.3 LOPDGDD).
3. Calendari de festius autonòmics i locals aplicable a cada centre.
4. Jornada anual o mensual concreta del conveni vigent i criteris de compensació d'hores extra.
5. Tolerància de retard i prolongació, i política per als fitxatges fora de radi.
