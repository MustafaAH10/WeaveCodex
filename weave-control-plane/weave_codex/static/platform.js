(() => {
  const root = document.documentElement;
  const stackButtons = [...document.querySelectorAll("[data-stack-choice]")];

  function setStack(value) {
    root.dataset.stack = value;
    stackButtons.forEach((button) => {
      const active = button.dataset.stackChoice === value;
      button.classList.toggle("active", active);
      button.setAttribute("aria-pressed", String(active));
    });
  }

  stackButtons.forEach((button) => {
    button.addEventListener("click", () => setStack(button.dataset.stackChoice));
  });

  const layerTabs = [...document.querySelectorAll("[data-layer]")];
  layerTabs.forEach((tab, index) => {
    tab.addEventListener("click", () => selectLayer(tab));
    tab.addEventListener("keydown", (event) => {
      if (!['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
      event.preventDefault();
      const direction = event.key === 'ArrowRight' ? 1 : -1;
      const next = layerTabs[(index + direction + layerTabs.length) % layerTabs.length];
      selectLayer(next);
      next.focus();
    });
  });

  function selectLayer(selected) {
    layerTabs.forEach((tab) => {
      const active = tab === selected;
      tab.classList.toggle("active", active);
      tab.setAttribute("aria-selected", String(active));
      tab.tabIndex = active ? 0 : -1;
      document.getElementById(`panel-${tab.dataset.layer}`).hidden = !active;
    });
  }

  const scenarios = {
    design: {
      prompt: "Review these launch assets and prepare the strongest final direction.",
      regular: "Returns a revised direction and summary after inspecting the brief and files. Progress is visible, but the agent chooses when to converge.",
      phases: ["Inspect brief", "Propose two", "Human picks", "Verify final"],
      decision: "Direction B approved with a typography change",
      verifier: "Brief coverage 6/6; export checklist passed",
      scope: "Selected asset folder; memory off"
    },
    ops: {
      prompt: "Investigate this delayed shipment and recommend the best recovery action.",
      regular: "Investigates the available records and recommends an action. A tool approval may protect the final write, but the investigation shape is agent-owned.",
      phases: ["Gather facts", "Compare paths", "Approve action", "Confirm record"],
      decision: "Expedite approved; rebooking remains gated",
      verifier: "Cost and ETA fields confirmed after refresh",
      scope: "Shipment 1842; logistics tools only"
    },
    research: {
      prompt: "Compare three vendors and write a recommendation for the purchasing team.",
      regular: "Produces a sourced comparison and recommendation. The result can be useful, but the review criteria live mostly in the original request.",
      phases: ["Define rubric", "Research", "Review evidence", "Write memo"],
      decision: "Security evidence accepted; pricing caveat added",
      verifier: "Every claim linked to captured evidence",
      scope: "Approved sources; no external writes"
    }
  };

  const scenarioTabs = [...document.querySelectorAll("[data-scenario]")];
  function setScenario(name) {
    const value = scenarios[name];
    if (!value) return;
    document.querySelector('[data-example="prompt"]').textContent = value.prompt;
    document.querySelector('[data-example="regular"]').textContent = value.regular;
    document.querySelector('[data-example="decision"]').textContent = value.decision;
    document.querySelector('[data-example="verifier"]').textContent = value.verifier;
    document.querySelector('[data-example="scope"]').textContent = value.scope;
    const phaseHost = document.querySelector('[data-example="phases"]');
    phaseHost.replaceChildren(...value.phases.map((phase, index) => {
      const node = document.createElement('div');
      node.className = 'mini-phase';
      node.innerHTML = `<em>${index === 2 ? 'Checkpoint' : index === 3 ? 'Verify' : 'Work'}</em><b></b>`;
      node.querySelector('b').textContent = phase;
      return node;
    }));
    scenarioTabs.forEach((tab) => {
      const active = tab.dataset.scenario === name;
      tab.classList.toggle('active', active);
      tab.setAttribute('aria-selected', String(active));
    });
  }

  scenarioTabs.forEach((button) => button.addEventListener('click', () => setScenario(button.dataset.scenario)));
  setScenario('design');

  const navLinks = [...document.querySelectorAll('.site-header nav a')];
  const observed = navLinks.map((link) => document.querySelector(link.getAttribute('href'))).filter(Boolean);
  if ('IntersectionObserver' in window) {
    const observer = new IntersectionObserver((entries) => {
      const visible = entries.filter((entry) => entry.isIntersecting).sort((a, b) => b.intersectionRatio - a.intersectionRatio)[0];
      if (!visible) return;
      navLinks.forEach((link) => link.classList.toggle('active', link.getAttribute('href') === `#${visible.target.id}`));
    }, { rootMargin: '-20% 0px -68% 0px', threshold: [0, .2, .6] });
    observed.forEach((section) => observer.observe(section));
  }
})();
