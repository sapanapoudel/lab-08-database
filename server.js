'use strict'
// API Dependencies
const express = require('express');
const cors = require('cors');
const superagent = require('superagent')
const pg = require('pg');

//Load environment variables from .env files 
require('dotenv').config();

//Application server 
const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());

//Database setup
const client = new pg.Client(process.env.DATABASE_URL);
client.connect();
client.on('error', err => console.error(err));


// Location Route
app.get('/location', getLocation);
// Weather Route
app.get('/weather', getWeatherRoute);
//Event Route
app.get('/events', getEventRoute);
//Movie Route
app.get('/movies', getMovies);

app.use('*', (request, response) => response.send('you got to the wrong place'));

//================Start the server============================
app.listen(PORT, () => {
  console.log(`App is running on port ${PORT}`);
});

//Error handler 
function handleError(err, res) {
  console.error(err);
  if (res) res.status(500).send('sorry, something went wrong');
}

//Lookup for the result in the database before making API call
function lookup(options) {
  const SQL = `SELECT * FROM ${options.tableName} WHERE location_id=$1;`;
  const values = [options.location];

  client.query(SQL, values).then(result => {
    if (result.rowCount > 0) {
      options.cacheHit(result);
    } else {
      options.cacheMiss();
    }
  })
    .catch(error => handleError(error));
}

//==================Location Route=================================
function Location(query, result) {
  this.tableName = 'locations',
  this.search_query = query,
  this.formatted_query = result.body.results[0].formatted_address,
  this.latitude = result.body.results[0].geometry.location.lat,
  this.longitude = result.body.results[0].geometry.location.lng;
}

Location.lookupLocation = (location) => {
  const SQL = `SELECT * FROM locations WHERE search_query=$1;`;
  const values = [location.query];

  return client.query(SQL, values).then(result => {
    if (result.rowCount > 0) {
      location.cacheHit(result);
    } else {
      location.cacheMiss();
    }
  })
    .catch(console.error);
}

Location.prototype = {
  save: function () {
    const SQL = `INSERT INTO locations (search_query, formatted_query, latitude, longitude) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING RETURNING id;`;
    const values = [this.search_query, this.formatted_query, this.latitude, this.longitude];

    return client.query(SQL, values)
      .then(result => {
        this.id = result.rows[0].id;
        return this;
      });
  }
};

function getLocation(request, response) {
  Location.lookupLocation({
    tableName: Location.tableName,
    query: request.query.data,

    cacheHit: function (result) {
      response.send(result.rows[0]);
    },
    cacheMiss: function () {
      const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${this.query}&key=${process.env.GEOCODE_API_KEY}`;

      return superagent.get(url)
        .then(result => {
          const location = new Location(this.query, result);
          location.save()
            .then(location => response.send(location));

        })

        .catch(error => handleError(error));

    }
  });
}

//===========Weather Route======================================
function Weather(weatherData) {
  this.tableName = 'weathers'
  this.forecast = weatherData.summary;
  let time = new Date(weatherData.time * 1000).toDateString();
  this.time = time;
}

Weather.tableName = 'weathers';
Weather.lookup = lookup;

Weather.prototype = {
  save: function (location_id) {
    const SQL = `INSERT INTO ${this.tableName} (forecast, time, location_id) VALUES ($1, $2, $3);`;
    const values = [this.forecast, this.time, location_id];
    client.query(SQL, values);
  }
};

function getWeatherRoute(request, response) {

  Weather.lookup({
    tableName: Weather.tableName,
    location: request.query.data.id,

    cacheHit: function (result) {
      response.send(result.rows);
    },

    cacheMiss: function () {
      const url = `https://api.darksky.net/forecast/${process.env.WEATHER_API_KEY}/${request.query.data.latitude},${request.query.data.longitude}`;

      superagent.get(url)
        .then(result => {
          const weatherSummaries = result.body.daily.data.map((el) => {
            const summary = new Weather(el);
            summary.save(request.query.data.id);
            return summary;

          });
          response.send(weatherSummaries);

        }).catch(error => handleError(error, response));

    }
  })

}

//============Eventbrite=================
//Event constructor
function Event(event) {
  this.tableName = 'events';
  this.link = event.url,
  this.name = event.name.text,
  this.event_date = new Date(event.start.local).toDateString(),
  this.summary = event.summary;
}

Event.tableName = 'events';
Event.lookup = lookup;

Event.prototype = {
  save: function (location_id) {
    const SQL = `INSERT INTO ${this.tableName} (link, name, event_date, summary, location_id) VALUES ($1, $2, $3, $4, $5);`;
    const values = [this.link, this.name, this.event_date, this.summary, location_id];
    client.query(SQL, values);
  }
};

//Route function
function getEventRoute(request, response) {
  Event.lookup({
    tableName: Event.tableName,
    location: request.query.data.id,

    cacheHit: function (result) {
      response.send(result.rows);
    },

    cacheMiss: function () {
      const url = `https://www.eventbriteapi.com/v3/events/search/?token=${process.env.EVENTBRITE_API_KEY}&location.address=${request.query.data.formatted_query}`;

      superagent.get(url)
        .then(result => {
          const eventSummery = result.body.events.map((event) => {

            const summary = new Event(event);
            summary.save(request.query.data.id);
            return summary;
          });
          response.send(eventSummery);
       
        })
        .catch(error => handleError(error, response)); 
    }
  })
}

//==============movies=======================
//movies constructor 
function Movie(movie) {
  this.tableName = 'movies'
  this.title = movie.title;
  this.overview = movie.overview;
  this.average_votes = movie.vote_average;
  this.total_votes = movie.vote_count;
  this.image_url = 'https://image.tmdb.org/t/p/w500' + movie.poster_path;
  this.popularity = movie.popularity;
  this.released_on = movie.released_date;
}

Movie.tableName = 'movies';
Movie.lookup = lookup;

Movie.prototype = {
  save: function (location_id) {
    const SQL = `INSERT INTO ${this.tableName} (title, overview, average_votes, total_votes, image_url, popularity, released_on, location_id) VALUES ($1, $2, $3, $4, $5, $6, $7, $8);`;
    const values = [this.title, this.overview, this.average_votes, this.total_votes, this.image_url, this.popularity, this.released_on, location_id];

    client.query(SQL, values);
  }
}
function getMovies(request, response) {
  Movie.lookup ({
    tableName: Movie.tableName,
    location: request.query.data.id,

    cacheHit: function(result) {
      response.send(result.rows);
    },

    cacheMiss: function() {
      const locationName = request.query.data.search_query;
      const url = `https://api.themoviedb.org/3/search/movie?api_key=${process.env.MOVIE_API_KEY}&language=en-US&query=${locationName}&page=1&include_adult=false`;

      superagent.get(url)
        .then(result => {
          const movieSummary = result.body.results.map(movieData => {
            const summary = new Movie(movieData);
            summary.save(request.query.data.id);
            return summary;
          });

          response.send(movieSummary);
        })
        .catch(error => handleError(error, response));
    }
  });
}
