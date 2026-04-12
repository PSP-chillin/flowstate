// ============== CONFIGURATION ==============
// Netlify injects values into window.__ENV__ at deploy time.
const SUPABASE_CONFIG = {
    url: window.__ENV__?.SUPABASE_URL || localStorage.getItem('supabaseUrl') || '',
    key: window.__ENV__?.SUPABASE_KEY || localStorage.getItem('supabaseKey') || ''
};

const CONFIG = {
    normalThreshold: 5,
    warningThreshold: 15,
    costPerLiter: 0.05,
    chartPointsLimit: 60, // Last 60 data points
    maxReadingsFetch: 1440
};



let supabaseClient = null;
let isConfigured = false;
let readingsSubscription = null;
let alertsSubscription = null;
let isDarkMode = false;
let alertFilterSeverity = 'all';
let alertSearchTerm = '';
let alertAckFilter = 'open';
let mobileCriticalOnly = false;
const chartTimeframes = {
    flow: '1h',
    volume: '1h',
    hourly: '1h',
    loss: '1h',
    humidity: '1h'
};
const acknowledgedAlertKeys = new Set(JSON.parse(localStorage.getItem('acknowledgedAlerts') || '[]'));

// Data storage
const dataStore = {
    readings: [],
    alerts: [],
    hourlyUsage: {}
};

// Chart instances
let flowChart = null;
let volumeChart = null;
let hourlyChart = null;
let lossChart = null;
let humidityChart = null;

// ============== INITIALIZATION ==============
document.addEventListener('DOMContentLoaded', function() {
    console.log('Dashboard initialized');
    initializeRevealAnimations();
    setupAlertsUI();
    setupAlertAcknowledgementUI();
    setupChartTimeframeControls();
    setupTimeframeSparklineUI();
    loadTheme();
    setupThemeToggle();
    setupMobileCriticalMode();
    loadConfiguration();
    initSupabase(SUPABASE_CONFIG.url, SUPABASE_CONFIG.key);
    initializeCharts();
    refreshChartTitles();
    startMonitoring();
});

function timeframeToMs(range) {
    const mapping = {
        '15m': 15 * 60 * 1000,
        '1h': 60 * 60 * 1000,
        '6h': 6 * 60 * 60 * 1000,
        '24h': 24 * 60 * 60 * 1000
    };
    return mapping[range] || mapping['1h'];
}

function getPointsLimitForRange(range) {
    const mapping = {
        '15m': 45,
        '1h': 90,
        '6h': 180,
        '24h': 280
    };
    return mapping[range] || 90;
}

function getFilteredReadings(range) {
    const readings = Array.isArray(dataStore.readings) ? dataStore.readings : [];
    if (readings.length === 0) return [];

    const now = Date.now();
    const threshold = now - timeframeToMs(range);
    const withinRange = readings.filter(r => new Date(r.timestamp).getTime() >= threshold);
    const source = withinRange.length > 0 ? withinRange : readings;
    const pointLimit = getPointsLimitForRange(range);

    if (source.length <= pointLimit) {
        return source;
    }

    const sampled = [];
    const stride = Math.ceil(source.length / pointLimit);
    for (let index = 0; index < source.length; index += stride) {
        sampled.push(source[index]);
    }

    if (sampled[sampled.length - 1] !== source[source.length - 1]) {
        sampled.push(source[source.length - 1]);
    }

    return sampled;
}

function setupChartTimeframeControls() {
    const controls = document.querySelectorAll('.timeframe-tabs');
    controls.forEach(group => {
        const chartKey = group.dataset.chart;
        const buttons = group.querySelectorAll('.timeframe-tab');

        buttons.forEach(button => {
            button.addEventListener('click', () => {
                const selectedRange = button.dataset.range || '1h';
                chartTimeframes[chartKey] = selectedRange;
                buttons.forEach(btn => btn.classList.toggle('active', btn === button));
                refreshChartTitles();
                updateCharts();
            });
        });
    });
}

function refreshChartTitles() {
    const chartTitles = document.querySelectorAll('[data-chart-title]');
    chartTitles.forEach(title => {
        const chartKey = title.dataset.chartTitle;
        const selectedRange = chartTimeframes[chartKey] || '1h';
        const map = {
            flow: 'Flow Rate Trend',
            volume: 'Accumulated Volume',
            hourly: 'Hourly Usage Pattern',
            loss: 'Loss Percentage Trend',
            humidity: 'Humidity Trend'
        };
        title.textContent = `${map[chartKey] || 'Trend'} (${selectedRange})`;
    });
}

function getAlertKey(alert) {
    if (alert?.id !== undefined && alert?.id !== null) {
        return `id:${alert.id}`;
    }
    return `${alert?.timestamp || 'na'}|${alert?.alert_type || 'alert'}|${alert?.message || ''}`;
}

function saveAcknowledgedAlerts() {
    localStorage.setItem('acknowledgedAlerts', JSON.stringify(Array.from(acknowledgedAlertKeys)));
}

function setupAlertAcknowledgementUI() {
    const container = document.getElementById('alertsContainer');
    if (!container) return;

    container.addEventListener('click', (event) => {
        const button = event.target.closest('.ack-btn');
        if (!button) return;

        const alertKey = button.dataset.alertKey;
        if (!alertKey) return;

        if (acknowledgedAlertKeys.has(alertKey)) {
            acknowledgedAlertKeys.delete(alertKey);
            showAlert('Alert moved back to open', 'warning');
        } else {
            acknowledgedAlertKeys.add(alertKey);
            showAlert('Alert acknowledged', 'normal');
        }

        saveAcknowledgedAlerts();
        updateAlerts(dataStore.alerts || []);
    });
}

function setupMobileCriticalMode() {
    const switchInput = document.getElementById('mobileCriticalOnly');
    if (!switchInput) return;

    mobileCriticalOnly = localStorage.getItem('mobileCriticalOnly') === 'true';
    switchInput.checked = mobileCriticalOnly;
    applyMobileCriticalMode();

    switchInput.addEventListener('change', () => {
        mobileCriticalOnly = switchInput.checked;
        localStorage.setItem('mobileCriticalOnly', String(mobileCriticalOnly));
        applyMobileCriticalMode();
        updateAlerts(dataStore.alerts || []);
    });
}

function applyMobileCriticalMode() {
    const shouldApply = mobileCriticalOnly && window.matchMedia('(max-width: 768px)').matches;
    document.body.classList.toggle('mobile-critical-mode', shouldApply);
}

function getChartTheme() {
    if (isDarkMode) {
        return {
            text: '#d2e5ef',
            grid: 'rgba(174, 209, 224, 0.14)',
            flow1Line: '#5bb9ff',
            flow1Fill: 'rgba(91, 185, 255, 0.16)',
            flow2Line: '#48d798',
            flow2Fill: 'rgba(72, 215, 152, 0.16)',
            vol1: 'rgba(91, 185, 255, 0.78)',
            vol2: 'rgba(72, 215, 152, 0.78)',
            hourly: 'rgba(245, 173, 63, 0.82)',
            lossLine: '#ff7c73',
            lossFill: 'rgba(255, 124, 115, 0.18)',
            humidityLine: '#54d0f3',
            humidityFill: 'rgba(84, 208, 243, 0.2)'
        };
    }

    return {
        text: '#264252',
        grid: 'rgba(38, 66, 82, 0.12)',
        flow1Line: '#0f87c8',
        flow1Fill: 'rgba(15, 135, 200, 0.14)',
        flow2Line: '#0d9f6b',
        flow2Fill: 'rgba(13, 159, 107, 0.14)',
        vol1: 'rgba(15, 135, 200, 0.72)',
        vol2: 'rgba(13, 159, 107, 0.72)',
        hourly: 'rgba(240, 153, 30, 0.76)',
        lossLine: '#d4534b',
        lossFill: 'rgba(212, 83, 75, 0.16)',
        humidityLine: '#148eb2',
        humidityFill: 'rgba(20, 142, 178, 0.18)'
    };
}

function createChartOptions(theme) {
    return {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
            legend: {
                display: true,
                position: 'top',
                labels: {
                    color: theme.text,
                    boxWidth: 12,
                    usePointStyle: true,
                    pointStyle: 'circle'
                }
            }
        },
        scales: {
            x: {
                ticks: { color: theme.text },
                grid: { color: theme.grid }
            },
            y: {
                beginAtZero: true,
                ticks: { color: theme.text },
                grid: { color: theme.grid }
            }
        }
    };
}

function applyChartTheme() {
    const theme = getChartTheme();
    const chartOptions = createChartOptions(theme);

    if (flowChart) {
        flowChart.data.datasets[0].borderColor = theme.flow1Line;
        flowChart.data.datasets[0].backgroundColor = theme.flow1Fill;
        flowChart.data.datasets[1].borderColor = theme.flow2Line;
        flowChart.data.datasets[1].backgroundColor = theme.flow2Fill;
        flowChart.options = { ...chartOptions };
        flowChart.update('none');
    }

    if (volumeChart) {
        volumeChart.data.datasets[0].backgroundColor = theme.vol1;
        volumeChart.data.datasets[1].backgroundColor = theme.vol2;
        volumeChart.options = { ...chartOptions };
        volumeChart.update('none');
    }

    if (hourlyChart) {
        hourlyChart.data.datasets[0].backgroundColor = theme.hourly;
        hourlyChart.options = { ...chartOptions };
        hourlyChart.update('none');
    }

    if (lossChart) {
        lossChart.data.datasets[0].borderColor = theme.lossLine;
        lossChart.data.datasets[0].backgroundColor = theme.lossFill;
        lossChart.options = { ...chartOptions };
        lossChart.update('none');
    }

    if (humidityChart) {
        humidityChart.data.datasets[0].borderColor = theme.humidityLine;
        humidityChart.data.datasets[0].backgroundColor = theme.humidityFill;
        humidityChart.options = {
            ...chartOptions,
            scales: {
                ...chartOptions.scales,
                y: {
                    ...chartOptions.scales.y,
                    min: 0,
                    max: 100,
                    ticks: {
                        ...chartOptions.scales.y.ticks,
                        callback: value => `${value}%`
                    }
                }
            }
        };
        humidityChart.update('none');
    }
}

function setupAlertsUI() {
    const tabs = document.querySelectorAll('.alerts-tab');
    const ackTabs = document.querySelectorAll('.alerts-ack-tab');
    const searchInput = document.getElementById('alertSearch');

    tabs.forEach(tab => {
        tab.addEventListener('click', () => {
            alertFilterSeverity = tab.dataset.severity || 'all';
            tabs.forEach(btn => btn.classList.toggle('active', btn === tab));
            updateAlerts(dataStore.alerts || []);
        });
    });

    if (searchInput) {
        searchInput.addEventListener('input', (event) => {
            alertSearchTerm = (event.target.value || '').trim().toLowerCase();
            updateAlerts(dataStore.alerts || []);
        });
    }

    ackTabs.forEach(tab => {
        tab.addEventListener('click', () => {
            alertAckFilter = tab.dataset.ack || 'open';
            ackTabs.forEach(btn => btn.classList.toggle('active', btn === tab));
            updateAlerts(dataStore.alerts || []);
        });
    });
}

function setupTimeframeSparklineUI() {
    const tabs = document.querySelectorAll('.timeframe-tab');
    tabs.forEach(tab => {
        if (tab.querySelector('.timeframe-sparkline')) return;

        const label = tab.textContent.trim();
        tab.textContent = '';

        const labelSpan = document.createElement('span');
        labelSpan.className = 'timeframe-label';
        labelSpan.textContent = label;

        const spark = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        spark.setAttribute('viewBox', '0 0 26 10');
        spark.setAttribute('aria-hidden', 'true');
        spark.classList.add('timeframe-sparkline');

        const polyline = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
        polyline.classList.add('timeframe-sparkline-line');
        polyline.setAttribute('points', '1,8 8,7 14,6 20,5 25,4');
        spark.appendChild(polyline);

        tab.appendChild(labelSpan);
        tab.appendChild(spark);
    });
}

function getChartMetricValue(chartKey, reading) {
    switch (chartKey) {
        case 'flow':
            return Number(reading.flow_rate_1 || 0) + Number(reading.flow_rate_2 || 0);
        case 'volume':
            return Number(reading.flow_rate_1 || 0) * 0.1;
        case 'hourly':
            return Number(reading.flow_rate_1 || 0);
        case 'loss':
            return Number(reading.percentage_loss || 0);
        case 'humidity': {
            const humidity = Number(reading.humidity);
            return Number.isFinite(humidity) ? humidity : 0;
        }
        default:
            return 0;
    }
}

function sampleValues(values, targetCount = 6) {
    if (values.length <= targetCount) return values;
    const sampled = [];
    const stride = (values.length - 1) / (targetCount - 1);
    for (let index = 0; index < targetCount; index++) {
        sampled.push(values[Math.round(index * stride)]);
    }
    return sampled;
}

function valuesToSparklinePoints(values) {
    if (!values.length) return '1,8 8,7 14,6 20,5 25,4';

    const sampled = sampleValues(values, 6);
    const min = Math.min(...sampled);
    const max = Math.max(...sampled);
    const span = Math.max(max - min, 0.0001);

    return sampled.map((value, index) => {
        const x = Math.round((index / Math.max(sampled.length - 1, 1)) * 24) + 1;
        const normalized = (value - min) / span;
        const y = Math.round((1 - normalized) * 7) + 1;
        return `${x},${y}`;
    }).join(' ');
}

function updateTimeframeSparklines() {
    const groups = document.querySelectorAll('.timeframe-tabs');
    groups.forEach(group => {
        const chartKey = group.dataset.chart;
        const tabs = group.querySelectorAll('.timeframe-tab');

        tabs.forEach(tab => {
            const range = tab.dataset.range || '1h';
            const readings = getFilteredReadings(range);
            const values = readings.map(reading => getChartMetricValue(chartKey, reading));
            const points = valuesToSparklinePoints(values);
            const line = tab.querySelector('.timeframe-sparkline-line');

            if (line) {
                line.setAttribute('points', points);
            }
        });
    });
}

function initializeRevealAnimations() {
    const revealTargets = document.querySelectorAll('.card, .chart-container');
    if (revealTargets.length === 0) return;

    revealTargets.forEach((el, index) => {
        el.classList.add('card-reveal');
        el.style.transition = `opacity 420ms ease ${Math.min(index * 40, 320)}ms, transform 420ms ease ${Math.min(index * 40, 320)}ms`;
    });

    const observer = new IntersectionObserver((entries) => {
        entries.forEach(entry => {
            if (entry.isIntersecting) {
                entry.target.classList.add('visible');
                observer.unobserve(entry.target);
            }
        });
    }, { threshold: 0.1 });

    revealTargets.forEach(el => observer.observe(el));
}

// ============== THEME MANAGEMENT ==============
function loadTheme() {
    const savedTheme = localStorage.getItem('theme');
    isDarkMode = savedTheme === 'dark';
    applyTheme(isDarkMode);
}

function setupThemeToggle() {
    const themeToggle = document.getElementById('themeToggle');
    if (themeToggle) {
        themeToggle.addEventListener('click', toggleTheme);
    }
}

function toggleTheme() {
    isDarkMode = !isDarkMode;
    localStorage.setItem('theme', isDarkMode ? 'dark' : 'light');
    applyTheme(isDarkMode);
    updateThemeButtonDisplay();
}

function applyTheme(dark) {
    if (dark) {
        document.body.classList.add('dark-mode');
        document.documentElement.style.setProperty('--bg-color', '#0d1117');
        document.documentElement.style.setProperty('--text-color', '#e6edf3');
        document.documentElement.style.setProperty('--card-bg', 'rgba(13, 17, 23, 0.7)');
    } else {
        document.body.classList.remove('dark-mode');
        document.documentElement.style.setProperty('--bg-color', '#F0F4F8');
        document.documentElement.style.setProperty('--text-color', '#0D1B2A');
        document.documentElement.style.setProperty('--card-bg', 'rgba(255, 255, 255, 0.7)');
    }
    updateThemeButtonDisplay();
    applyChartTheme();
}

function updateThemeButtonDisplay() {
    const themeToggle = document.getElementById('themeToggle');
    if (themeToggle) {
        themeToggle.textContent = isDarkMode ? 'Switch to Day Mode' : 'Switch to Night Mode';
    }
}

// ============== CONFIGURATION MANAGEMENT ==============
// Credentials are set in SUPABASE_CONFIG at the top of this file
// To change credentials, edit the SUPABASE_CONFIG object above

function initSupabase(url, key) {
    try {
        supabaseClient = window.supabase.createClient(url, key);
        isConfigured = true;
        console.log('Supabase client initialized');
        console.log('URL:', url);
        updateSystemStatus(true);
        
        // Diagnostic: list all tables
        diagnoseSupabase();
    } catch (error) {
        console.error('Failed to initialize Supabase:', error);
        isConfigured = false;
        updateSystemStatus(false);
        showAlert('Failed to connect to Supabase', 'critical');
    }
}

async function diagnoseSupabase() {
    try {
        console.log('=== Supabase Diagnostic ===');
        
        // Try to fetch from water_readings
        const { data: wr, error: wr_error, status: wr_status } = await supabaseClient
            .from('water_readings')
            .select('count', { count: 'exact', head: true });
        
        if (wr_error) {
            console.error('❌ water_readings error:', wr_error.message, 'Code:', wr_error.code);
        } else {
            console.log('✓ water_readings table exists');
        }
        
        // Try to fetch from alerts
        const { data: alerts, error: alerts_error, status: alerts_status } = await supabaseClient
            .from('alerts')
            .select('count', { count: 'exact', head: true });
        
        if (alerts_error) {
            console.error('❌ alerts error:', alerts_error.message, 'Code:', alerts_error.code);
        } else {
            console.log('✓ alerts table exists');
        }
        
        // Try to fetch any data
        const { data: data_test, error: data_error } = await supabaseClient
            .from('water_readings')
            .select('*')
            .limit(1);
        
        if (data_error) {
            console.error('❌ Cannot read water_readings:', data_error.message);
        } else {
            console.log('✓ Can read water_readings, records found:', data_test?.length || 0);
            if (data_test && data_test.length > 0) {
                console.log('Sample record:', data_test[0]);
            }
        }
    } catch (error) {
        console.error('Diagnostic error:', error);
    }
}

function resetData() {
    if (confirm('Are you sure? This will clear all local data.')) {
        dataStore.readings = [];
        dataStore.alerts = [];
        dataStore.hourlyUsage = {};
        updateCharts();
        showAlert('All data cleared', 'normal');
    }
}

function saveConfiguration() {
    const url = document.getElementById('supabaseUrl')?.value || SUPABASE_CONFIG.url;
    const key = document.getElementById('supabaseKey')?.value || SUPABASE_CONFIG.key;
    const normalThreshold = parseFloat(document.getElementById('normalThreshold')?.value || CONFIG.normalThreshold);
    const warningThreshold = parseFloat(document.getElementById('warningThreshold')?.value || CONFIG.warningThreshold);

    // Save to localStorage
    localStorage.setItem('supabaseUrl', url);
    localStorage.setItem('supabaseKey', key);
    localStorage.setItem('normalThreshold', normalThreshold);
    localStorage.setItem('warningThreshold', warningThreshold);

    // Update CONFIG
    CONFIG.normalThreshold = normalThreshold;
    CONFIG.warningThreshold = warningThreshold;

    // Reinitialize Supabase if credentials changed
    initSupabase(url, key);
    
    showAlert('Configuration saved successfully', 'normal');
    console.log('Configuration saved');
}

function loadConfiguration() {
    const savedUrl = localStorage.getItem('supabaseUrl');
    const savedKey = localStorage.getItem('supabaseKey');
    const savedNormalThreshold = localStorage.getItem('normalThreshold');
    const savedWarningThreshold = localStorage.getItem('warningThreshold');

    if (savedUrl) document.getElementById('supabaseUrl').value = savedUrl;
    if (savedKey) document.getElementById('supabaseKey').value = savedKey;
    if (savedNormalThreshold) document.getElementById('normalThreshold').value = savedNormalThreshold;
    if (savedWarningThreshold) document.getElementById('warningThreshold').value = savedWarningThreshold;
}



// ============== MONITORING ==============
function startMonitoring() {
    // Initial fetch
    fetchLatestData();
    // Subscribe to realtime updates
    subscribeToRealtimeUpdates();
}

function subscribeToRealtimeUpdates() {
    if (!isConfigured || !supabaseClient) {
        setTimeout(subscribeToRealtimeUpdates, 5000); // Retry in 5 seconds
        return;
    }

    try {
        // Subscribe to water_readings changes using new Supabase v2+ API
        readingsSubscription = supabaseClient
            .channel('public:water_readings')
            .on('postgres_changes', 
                { event: '*', schema: 'public', table: 'water_readings' },
                payload => {
                    console.log('Realtime reading update:', payload);
                    fetchLatestData();
                }
            )
            .subscribe();

        // Subscribe to alerts changes using new Supabase v2+ API
        alertsSubscription = supabaseClient
            .channel('public:alerts')
            .on('postgres_changes',
                { event: '*', schema: 'public', table: 'alerts' },
                payload => {
                    console.log('Realtime alert update:', payload);
                    fetchLatestData();
                }
            )
            .subscribe();

        console.log('Realtime subscriptions established');
    } catch (error) {
        console.error('Error setting up realtime subscriptions:', error);
        // Fallback to polling if realtime fails
        setInterval(fetchLatestData, 5000);
    }
}

async function fetchLatestData() {
    if (!isConfigured || !supabaseClient) {
        console.warn('Supabase not configured or client missing');
        updateSystemStatus(false);
        return;
    }

    try {
        console.log('Fetching latest data from Supabase...');
        
        // Fetch latest reading
        const { data: readings, error: readingsError } = await supabaseClient
            .from('water_readings')
            .select('*')
            .order('timestamp', { ascending: false })
            .limit(CONFIG.maxReadingsFetch);

        if (readingsError) {
            console.error('Error fetching readings:', readingsError);
            throw readingsError;
        }

        console.log('Readings fetched:', readings?.length || 0, 'records');
        if (readings && readings.length > 0) {
            dataStore.readings = readings.reverse(); // Chronological order
            updateSystemStatus(true);
            console.log('Latest reading:', readings[readings.length - 1]);
            updateDashboard(readings[readings.length - 1]); // Latest reading
        } else {
            console.warn('No readings found in water_readings table');
        }

        // Fetch recent alerts
        const { data: alerts, error: alertsError } = await supabaseClient
            .from('alerts')
            .select('*')
            .order('timestamp', { ascending: false })
            .limit(10);

        if (alertsError) {
            console.warn('Alerts fetch error:', alertsError.message);
            // Don't throw - alerts table is optional
        } else {
            console.log('Alerts fetched:', alerts?.length || 0, 'records');
            if (alerts && alerts.length > 0) {
                console.log('First alert:', alerts[0]);
                dataStore.alerts = alerts.reverse(); // Reverse for chronological order
                updateAlerts(dataStore.alerts);
            } else {
                console.warn('No alerts in table');
                updateAlerts([]);
            }
        }

        // Update charts with all readings
        updateCharts();
        updateLastUpdate();
        updateExportStats(); // Update export stats after data is fetched

    } catch (error) {
        console.error('Error fetching data:', error);
        updateSystemStatus(false);
    }
}

// ============== DASHBOARD UPDATES ==============
function updateDashboard(latestReading) {
    // Update tank level
    const waterLevel = latestReading.water_level || 0;
    updateTankLevel(waterLevel);

    // Update flow rates
    document.getElementById('flow1').textContent = (latestReading.flow_rate_1 || 0).toFixed(2) + ' L/min';
    document.getElementById('flow2').textContent = (latestReading.flow_rate_2 || 0).toFixed(2) + ' L/min';

    // Update progress bars
    const maxFlow = Math.max(latestReading.flow_rate_1 || 0, latestReading.flow_rate_2 || 0, 5);
    document.getElementById('progressFlow1').style.width = ((latestReading.flow_rate_1 || 0) / maxFlow * 100) + '%';
    document.getElementById('progressFlow2').style.width = ((latestReading.flow_rate_2 || 0) / maxFlow * 100) + '%';

    // Update leak detection
    const percentageLoss = latestReading.percentage_loss || 0;
    updateLeakDetection(percentageLoss, latestReading.leak_status);

    // Update system controls
    const valveState = latestReading.valve_state === 1 ? 'OPEN' : 'CLOSED';
    
    const valveIndicator = document.getElementById('valveIndicator');
    valveIndicator.classList.toggle('active', latestReading.valve_state === 1);
    document.getElementById('valveState').textContent = valveState;

    // Update anomaly status
    const anomalyStatusElement = document.getElementById('anomalyStatus');
    if (anomalyStatusElement) {
        anomalyStatusElement.textContent = latestReading.anomaly_status || 'Learning';
    }

    // Update humidity panel
    updateHumidityDisplay(latestReading);

    // Update statistics
    const dailyTotal = (latestReading.daily_total_liters || 0).toFixed(2);
    document.getElementById('dailyTotal').textContent = dailyTotal + ' L';

    // Calculate estimated loss
    const volume1 = latestReading.flow_rate_1 || 0;
    const volume2 = latestReading.flow_rate_2 || 0;
    const estimatedLoss = (volume1 - volume2).toFixed(2);
    const minimumLoss = Math.max(0, estimatedLoss);
    document.getElementById('estimatedLoss').textContent = minimumLoss + ' L';

    // Calculate cost
    const cost = (dailyTotal * CONFIG.costPerLiter).toFixed(2);
    document.getElementById('estimatedCost').textContent = '$' + cost;

    // Update export stats
    updateExportStats();
}

function updateHumidityDisplay(latestReading) {
    const humidityRaw = latestReading?.humidity;
    const hasHumidity = humidityRaw !== null && humidityRaw !== undefined && Number.isFinite(Number(humidityRaw));
    const humidity = hasHumidity ? Math.max(0, Math.min(100, Number(humidityRaw))) : null;

    const humidityValue = document.getElementById('humidityValue');
    const humidityMeterFill = document.getElementById('humidityMeterFill');
    const humidityComfortBadge = document.getElementById('humidityComfortBadge');
    const humidityTrend = document.getElementById('humidityTrend');

    if (!humidityValue || !humidityMeterFill || !humidityComfortBadge || !humidityTrend) {
        return;
    }

    if (humidity === null) {
        humidityValue.textContent = 'N/A';
        humidityMeterFill.style.width = '0%';
        humidityComfortBadge.textContent = 'NO DATA';
        humidityComfortBadge.className = 'humidity-comfort humidity-comfort-muted';
        humidityTrend.textContent = 'Humidity column missing in latest row.';
        return;
    }

    humidityValue.textContent = `${humidity.toFixed(1)}%`;
    humidityMeterFill.style.width = `${humidity}%`;

    let comfortText = 'COMFORT';
    let comfortClass = 'humidity-comfort-good';

    if (humidity < 30) {
        comfortText = 'DRY AIR';
        comfortClass = 'humidity-comfort-dry';
    } else if (humidity > 70) {
        comfortText = 'VERY HUMID';
        comfortClass = 'humidity-comfort-wet';
    }

    humidityComfortBadge.textContent = comfortText;
    humidityComfortBadge.className = `humidity-comfort ${comfortClass}`;

    const recentWithHumidity = dataStore.readings
        .slice(-2)
        .filter(r => r.humidity !== null && r.humidity !== undefined && Number.isFinite(Number(r.humidity)));

    if (recentWithHumidity.length >= 2) {
        const previous = Number(recentWithHumidity[0].humidity);
        const delta = humidity - previous;
        const arrow = delta > 0.2 ? 'rising' : delta < -0.2 ? 'falling' : 'stable';
        humidityTrend.textContent = `Indoor air is ${arrow} (${delta >= 0 ? '+' : ''}${delta.toFixed(1)}%)`;
    } else {
        humidityTrend.textContent = 'Collecting humidity trend...';
    }
}

function updateTankLevel(waterLevel) {
    const maxLevel = 100;
    // Invert level: 100 - waterLevel (so full tank = highest value)
    const displayLevel = maxLevel - waterLevel;
    const percentage = Math.min(100, Math.max(0, (displayLevel / maxLevel) * 100));
    
    // Update liquid level: top position controls water height
    const liquid = document.querySelector('.water-tank .liquid');
    const label = document.getElementById('tankLabel');
    
    if (liquid) {
        liquid.style.top = `calc(100% - ${percentage}%)`;
    }
    
    // Update label with percentage
    if (label) {
        label.textContent = percentage.toFixed(0) + '%';
        label.style.bottom = percentage + '%';
    }
    
    // Update text display (show inverted level: 100 - waterLevel)
    document.getElementById('tankLevel').textContent = displayLevel.toFixed(1) + ' cm';
}

function updateLeakDetection(percentageLoss, leakStatus) {
    // Cap percentage at 100% max (prevent display issues with malformed data)
    const validPercentage = Math.min(100, Math.max(0, percentageLoss));
    
    // Debug: log if percentage is suspiciously high
    if (percentageLoss > 100) {
        console.warn('Unusual percentage detected:', percentageLoss, 'capped to', validPercentage);
    }
    
    document.getElementById('lossPercentage').textContent = validPercentage.toFixed(1);

    // Update circle progress
    const progress = document.getElementById('circleProgress');
    const maxPercentage = 30;
    const dashOffset = 345 * (1 - Math.min(validPercentage, maxPercentage) / maxPercentage);
    progress.style.strokeDashoffset = dashOffset;

    // Update color based on status
    progress.classList.remove('warning', 'critical');
    
    const badgeElement = document.getElementById('leakStatus');
    badgeElement.classList.remove('normal', 'warning', 'critical');

    if (leakStatus === 'Critical') {
        progress.classList.add('critical');
        badgeElement.classList.add('critical');
        badgeElement.textContent = 'CRITICAL ⚠️';
    } else if (leakStatus === 'Warning') {
        progress.classList.add('warning');
        badgeElement.classList.add('warning');
        badgeElement.textContent = 'WARNING ⚡';
    } else {
        badgeElement.classList.add('normal');
        badgeElement.textContent = 'NORMAL ✓';
    }
}

function updateAlerts(alerts) {
    const container = document.getElementById('alertsContainer');
    
    if (!container) {
        console.warn('Alert container not found');
        return;
    }
    
    const alertList = Array.isArray(alerts) ? alerts : [];
    console.log('Updating alerts display with', alertList.length, 'alerts');

    const criticalCount = alertList.filter(a => (a.severity === 'critical' || a.severity === 'high')).length;
    const warningCount = alertList.filter(a => (a.severity || '').toLowerCase() === 'warning' || (a.severity || '').toLowerCase() === 'medium').length;
    const allCountElement = document.getElementById('countAll');
    const criticalCountElement = document.getElementById('countCritical');
    const warningCountElement = document.getElementById('countWarning');

    if (allCountElement) allCountElement.textContent = String(alertList.length);
    if (criticalCountElement) criticalCountElement.textContent = String(criticalCount);
    if (warningCountElement) warningCountElement.textContent = String(warningCount);

    const filteredAlerts = alertList.filter(alert => {
        const normalizedSeverity = (alert.severity || '').toLowerCase();
        const mappedSeverity = (normalizedSeverity === 'critical' || normalizedSeverity === 'high') ? 'critical' : 'warning';
        const isAcknowledged = acknowledgedAlertKeys.has(getAlertKey(alert));

        if (alertAckFilter === 'open' && isAcknowledged) {
            return false;
        }

        if (alertAckFilter === 'acknowledged' && !isAcknowledged) {
            return false;
        }

        if (mobileCriticalOnly && window.matchMedia('(max-width: 768px)').matches && mappedSeverity !== 'critical') {
            return false;
        }

        if (alertFilterSeverity !== 'all' && mappedSeverity !== alertFilterSeverity) {
            return false;
        }

        if (!alertSearchTerm) return true;

        const haystack = `${alert.alert_type || ''} ${alert.message || ''} ${alert.severity || ''}`.toLowerCase();
        return haystack.includes(alertSearchTerm);
    });
    
    if (filteredAlerts.length === 0) {
        container.innerHTML = '<div class="alert-item" style="color: #666;">No alerts yet</div>';
        const ackSummary = document.getElementById('ackSummary');
        if (ackSummary) ackSummary.textContent = '0 unacknowledged';
        return;
    }

    const unacknowledgedCount = filteredAlerts.filter(alert => !acknowledgedAlertKeys.has(getAlertKey(alert))).length;
    const acknowledgedCount = filteredAlerts.length - unacknowledgedCount;
    const ackSummary = document.getElementById('ackSummary');
    if (ackSummary) {
        ackSummary.textContent = `${unacknowledgedCount} open • ${acknowledgedCount} acknowledged`;
    }

    container.innerHTML = '';
    filteredAlerts.slice(0, 20).forEach(alert => {
        const alertDiv = document.createElement('div');
        
        // Determine severity class
        const severityClass = (alert.severity === 'critical' || alert.severity === 'high') ? 'critical' : 'warning';
        const alertKey = getAlertKey(alert);
        const isAcknowledged = acknowledgedAlertKeys.has(alertKey);
        alertDiv.className = `alert-item ${severityClass}${isAcknowledged ? ' acknowledged' : ''}`;
        
        const timestamp = new Date(alert.timestamp).toLocaleString();
        alertDiv.innerHTML = `
            <strong>${alert.alert_type || 'Alert'}</strong>
            <div>${alert.message}</div>
            <div class="alert-timestamp">${timestamp}</div>
            <button class="ack-btn" data-alert-key="${alertKey}">
                ${isAcknowledged ? 'Unacknowledge' : 'Acknowledge'}
            </button>
        `;
        container.appendChild(alertDiv);
    });
}

function updateSystemStatus(online) {
    const badge = document.getElementById('systemStatus');
    if (!badge) return; // Element doesn't exist, skip update
    
    const dot = badge.querySelector('.status-dot');
    
    if (online) {
        if (dot) dot.classList.remove('offline');
        if (dot) dot.classList.add('online');
        badge.innerHTML = '<span class="status-dot online"></span>Online';
    } else {
        if (dot) dot.classList.remove('online');
        if (dot) dot.classList.add('offline');
        badge.innerHTML = '<span class="status-dot offline"></span>Offline';
    }
}

function updateLastUpdate() {
    const now = new Date();
    document.getElementById('lastUpdate').textContent = 'Last Update: ' + now.toLocaleTimeString();
}

// ============== CONTROL FUNCTIONS ==============
function openValve() {
    console.log('Opening valve');
    const valveIndicator = document.getElementById('valveIndicator');
    const valveState = document.getElementById('valveState');
    
    // Update UI
    if (valveIndicator) {
        valveIndicator.classList.add('active');
        valveIndicator.style.color = '#4CAF50';
    }
    if (valveState) {
        valveState.textContent = 'OPEN';
    }
    
    showAlert('Valve opened', 'normal');
}

function closeValve() {
    console.log('Closing valve');
    const valveIndicator = document.getElementById('valveIndicator');
    const valveState = document.getElementById('valveState');
    
    // Update UI
    if (valveIndicator) {
        valveIndicator.classList.remove('active');
        valveIndicator.style.color = '#f44336';
    }
    if (valveState) {
        valveState.textContent = 'CLOSED';
    }
    
    showAlert('Valve closed', 'normal');
}



// ============== CHARTS ==============
function initializeCharts() {
    const chartTheme = getChartTheme();
    const chartOptions = createChartOptions(chartTheme);

    // Flow Rate Chart
    const flowCtx = document.getElementById('flowChart');
    if (flowCtx) {
        flowChart = new Chart(flowCtx, {
            type: 'line',
            data: {
                labels: [],
                datasets: [
                    {
                        label: 'Flow Rate 1 (L/min)',
                        data: [],
                        borderColor: chartTheme.flow1Line,
                        backgroundColor: chartTheme.flow1Fill,
                        tension: 0.3,
                        fill: true
                    },
                    {
                        label: 'Flow Rate 2 (L/min)',
                        data: [],
                        borderColor: chartTheme.flow2Line,
                        backgroundColor: chartTheme.flow2Fill,
                        tension: 0.3,
                        fill: true
                    }
                ]
            },
            options: chartOptions
        });
    }

    // Volume Chart
    const volumeCtx = document.getElementById('volumeChart');
    if (volumeCtx) {
        volumeChart = new Chart(volumeCtx, {
            type: 'bar',
            data: {
                labels: [],
                datasets: [
                    {
                        label: 'Volume 1 (L)',
                        data: [],
                        backgroundColor: chartTheme.vol1
                    },
                    {
                        label: 'Volume 2 (L)',
                        data: [],
                        backgroundColor: chartTheme.vol2
                    }
                ]
            },
            options: chartOptions
        });
    }

    // Hourly Usage Chart
    const hourlyCtx = document.getElementById('hourlyChart');
    if (hourlyCtx) {
        hourlyChart = new Chart(hourlyCtx, {
            type: 'bar',
            data: {
                labels: Array.from({length: 24}, (_, i) => i + ':00'),
                datasets: [
                    {
                        label: 'Hourly Usage (L)',
                        data: Array(24).fill(0),
                        backgroundColor: chartTheme.hourly
                    }
                ]
            },
            options: chartOptions
        });
    }

    // Loss Percentage Chart
    const lossCtx = document.getElementById('lossChart');
    if (lossCtx) {
        lossChart = new Chart(lossCtx, {
            type: 'line',
            data: {
                labels: [],
                datasets: [
                    {
                        label: 'Loss %',
                        data: [],
                        borderColor: chartTheme.lossLine,
                        backgroundColor: chartTheme.lossFill,
                        tension: 0.3,
                        fill: true
                    }
                ]
            },
            options: chartOptions
        });
    }

    // Humidity Chart
    const humidityCtx = document.getElementById('humidityChart');
    if (humidityCtx) {
        humidityChart = new Chart(humidityCtx, {
            type: 'line',
            data: {
                labels: [],
                datasets: [
                    {
                        label: 'Humidity (%)',
                        data: [],
                        borderColor: chartTheme.humidityLine,
                        backgroundColor: chartTheme.humidityFill,
                        tension: 0.35,
                        fill: true
                    }
                ]
            },
            options: {
                ...chartOptions,
                scales: {
                    y: {
                        beginAtZero: true,
                        min: 0,
                        max: 100,
                        ticks: {
                            callback: value => `${value}%`
                        }
                    }
                }
            }
        });
    }

    applyChartTheme();
}

function updateCharts() {
    if (dataStore.readings.length === 0) return;

    const flowReadings = getFilteredReadings(chartTimeframes.flow);
    const volumeReadings = getFilteredReadings(chartTimeframes.volume);
    const lossReadings = getFilteredReadings(chartTimeframes.loss);
    const humidityReadings = getFilteredReadings(chartTimeframes.humidity);
    const hourlyReadings = getFilteredReadings(chartTimeframes.hourly);

    // Update Flow Chart
    if (flowChart) {
        flowChart.data.labels = flowReadings.map(r => {
            const date = new Date(r.timestamp);
            return date.toLocaleTimeString();
        });
        flowChart.data.datasets[0].data = flowReadings.map(r => r.flow_rate_1 || 0);
        flowChart.data.datasets[1].data = flowReadings.map(r => r.flow_rate_2 || 0);
        flowChart.update();
    }

    // Update Volume Chart (accumulated)
    if (volumeChart) {
        volumeChart.data.labels = volumeReadings.map(r => {
            const date = new Date(r.timestamp);
            return date.toLocaleTimeString();
        });
        volumeChart.data.datasets[0].data = volumeReadings.map(r => {
            return (r.flow_rate_1 || 0) * 0.1; // Approximate volume
        });
        volumeChart.data.datasets[1].data = volumeReadings.map(r => {
            return (r.flow_rate_2 || 0) * 0.1;
        });
        volumeChart.update();
    }

    // Update Loss Percentage Chart
    if (lossChart) {
        lossChart.data.labels = lossReadings.map(r => {
            const date = new Date(r.timestamp);
            return date.toLocaleTimeString();
        });
        lossChart.data.datasets[0].data = lossReadings.map(r => r.percentage_loss || 0);
        lossChart.update();
    }

    // Update Humidity Chart
    if (humidityChart) {
        humidityChart.data.labels = humidityReadings.map(r => {
            const date = new Date(r.timestamp);
            return date.toLocaleTimeString();
        });
        humidityChart.data.datasets[0].data = humidityReadings.map(r => {
            const humidity = Number(r.humidity);
            return Number.isFinite(humidity) ? humidity : null;
        });
        humidityChart.update();
    }

    // Update Hourly Chart (aggregate by hour)
    if (hourlyChart) {
        const hourlyData = Array(24).fill(0);
        const hourlyCount = Array(24).fill(0);

        hourlyReadings.forEach(r => {
            const date = new Date(r.timestamp);
            const hour = date.getHours();
            hourlyData[hour] += (r.flow_rate_1 || 0) * 0.1;
            hourlyCount[hour]++;
        });

        // Average by hour
        for (let i = 0; i < 24; i++) {
            if (hourlyCount[i] > 0) {
                hourlyData[i] = hourlyData[i] / hourlyCount[i];
            }
        }

        hourlyChart.data.datasets[0].data = hourlyData;
        hourlyChart.update();
    }

    updateTimeframeSparklines();
}

// ============== UTILITY FUNCTIONS ==============
function showAlert(message, type = 'normal') {
    console.log(`[${type.toUpperCase()}] ${message}`);

    const host = document.getElementById('toastHost');
    if (!host) {
        return;
    }

    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    toast.textContent = message;
    host.appendChild(toast);

    window.setTimeout(() => {
        toast.style.opacity = '0';
        toast.style.transform = 'translateY(8px)';
        window.setTimeout(() => toast.remove(), 200);
    }, 2800);
}

// ============== EXPORT & DOWNLOAD ==============
function exportData(format = 'json') {
    if (!dataStore.readings || dataStore.readings.length === 0) {
        showAlert('No data to export', 'warning');
        return;
    }

    let content, filename, type;

    if (format === 'csv') {
        content = convertToCSV(dataStore.readings);
        filename = `water_monitoring_${new Date().toISOString().split('T')[0]}.csv`;
        type = 'text/csv';
    } else if (format === 'json') {
        content = JSON.stringify(dataStore, null, 2);
        filename = `water_monitoring_${new Date().toISOString().split('T')[0]}.json`;
        type = 'application/json';
    }

    const dataBlob = new Blob([content], { type: type });
    const url = URL.createObjectURL(dataBlob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    link.click();
    URL.revokeObjectURL(url);
    showAlert(`Data exported as ${format.toUpperCase()} successfully`, 'normal');
}

function convertToCSV(readings) {
    if (!readings || readings.length === 0) return '';

    const headers = Object.keys(readings[0]);
    const csv = [headers.join(',')];

    readings.forEach(row => {
        const values = headers.map(header => {
            const value = row[header];
            // Escape values containing commas or quotes
            if (typeof value === 'string' && (value.includes(',') || value.includes('"'))) {
                return `"${value.replace(/"/g, '""')}"`;
            }
            return value;
        });
        csv.push(values.join(','));
    });

    return csv.join('\n');
}

function updateExportStats() {
    const recordCount = dataStore.readings ? dataStore.readings.length : 0;
    const alertCount = dataStore.alerts ? dataStore.alerts.length : 0;
    
    console.log('updateExportStats() - Records:', recordCount, 'Alerts:', alertCount, 'dataStore.alerts:', dataStore.alerts);
    
    const recordElement = document.getElementById('exportRecordCount');
    const alertElement = document.getElementById('exportAlertCount');
    
    if (recordElement) {
        recordElement.textContent = recordCount;
    }
    if (alertElement) {
        alertElement.textContent = alertCount;
    }
}

// ============== RESPONSIVE UPDATES ==============
window.addEventListener('resize', function() {
    applyMobileCriticalMode();
    if (flowChart) flowChart.resize();
    if (volumeChart) volumeChart.resize();
    if (hourlyChart) hourlyChart.resize();
    if (lossChart) lossChart.resize();
    if (humidityChart) humidityChart.resize();
});

// ============== KEYBOARD SHORTCUTS ==============
document.addEventListener('keydown', function(event) {
    if (event.ctrlKey && event.key === 's') {
        event.preventDefault();
        saveConfiguration();
    }
    if (event.key === 'r' && event.ctrlKey) {
        event.preventDefault();
        location.reload();
    }
});

console.log('Script loaded successfully');
